import { createSign, createHash } from 'node:crypto';
import { check, jsonFetch, delay } from './util.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export class ServiceAccountAuth {
  constructor(credentials, { fetcher = fetch, now = Date.now } = {}) { this.credentials = credentials; this.fetcher = fetcher; this.now = now; this.tokens = new Map(); }
  async token(scope) {
    const cached = this.tokens.get(scope);
    if (cached && cached.expires > this.now() + 60000) return cached.value;
    const c = this.credentials;
    check(c.type === 'service_account' && c.client_email && c.private_key, 'GOOGLE_CREDENTIALS', '서비스 계정 JSON 파일이 필요합니다.');
    const at = Math.floor(this.now() / 1000);
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: c.client_email, scope, aud: TOKEN_URL, iat: at, exp: at + 3600 })}`;
    const signer = createSign('RSA-SHA256'); signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(c.private_key, 'base64url')}`;
    const data = await jsonFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() }, this.fetcher);
    check(typeof data.access_token === 'string', 'GOOGLE_AUTH', 'Google 토큰 발급 실패');
    this.tokens.set(scope, { value: data.access_token, expires: this.now() + Math.min(Number(data.expires_in) || 3600, 3600) * 1000 });
    return data.access_token;
  }
}
export function normalizeChatEvent(event) {
  const payload = event.chat?.messagePayload;
  if (!payload && event.type !== 'MESSAGE' && !(event.type === 'ADDED_TO_SPACE' && event.message)) return null;
  const message = payload?.message || event.message;
  if (!message || message.sender?.type === 'BOT') return null;
  const space = payload?.space?.name || event.space?.name || message.space?.name;
  const user = message.sender?.name || event.user?.name || event.chat?.user?.name;
  check(/^spaces\/[A-Za-z0-9_-]+$/.test(space || ''), 'CHAT_EVENT', '잘못된 채팅방');
  check(/^users\/[A-Za-z0-9_-]+$/.test(user || ''), 'CHAT_EVENT', '잘못된 사용자');
  let text = message.argumentText;
  if (typeof text !== 'string') {
    text = message.text || '';
    const annotations = (message.annotations || []).filter(a => a.type === 'USER_MENTION' && a.userMention?.user?.type === 'BOT').sort((a, b) => b.startIndex - a.startIndex);
    for (const a of annotations) text = text.slice(0, a.startIndex || 0) + text.slice((a.startIndex || 0) + a.length);
  }
  return { text: text.trim(), space, user, thread: message.thread?.name, name: message.name, eventTime: event.eventTime || event.chat?.eventTime || message.createTime };
}
export class GoogleWorker {
  constructor({ config, auth, engine, fetcher = fetch, now = Date.now, log = console.warn }) { Object.assign(this, { config, auth, engine, fetcher, now, log }); this.running = false; }
  async request(scope, url, body) {
    return jsonFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${await this.auth.token(scope)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, this.fetcher);
  }
  async pubsub(method, body) {
    check(/^projects\/[A-Za-z0-9_-]+\/subscriptions\/[A-Za-z0-9_.~-]+$/.test(this.config.subscription || ''), 'SUBSCRIPTION', '올바른 Pub/Sub subscription 이름이 필요합니다.');
    return this.request('https://www.googleapis.com/auth/pubsub', `https://pubsub.googleapis.com/v1/${this.config.subscription}:${method}`, body);
  }
  async receive(item) {
    const raw = item.message;
    let event;
    try { event = JSON.parse(Buffer.from(raw.data || '', 'base64').toString('utf8')); }
    catch { return; } // poison message: acknowledge, do not retry forever.
    let command;
    try { command = normalizeChatEvent(event); } catch { return; }
    if (!command || !this.config.allowedSpaces.includes(command.space)) return;
    // Pub/Sub redelivery after a long outage must not suddenly play yesterday's request.
    const timestamp = Date.parse(command.eventTime || raw.publishTime || '');
    if (!Number.isFinite(timestamp) || this.now() - timestamp > 300000 || timestamp - this.now() > 60000) return;
    const eventId = command.name || `pubsub:${raw.messageId}`;
    check(eventId && !eventId.endsWith('undefined'), 'EVENT_ID', '메시지 식별자가 없습니다.');
    try {
      await this.engine.command({ ...command, eventId, operator: this.config.operatorUsers.includes(command.user) });
    } catch (e) {
      // User errors are durable replies; transient provider errors are retried by Pub/Sub.
      if (!e.status || e.status >= 500) throw e;
      await this.engine.serial(async () => {
        if (this.engine.state.seen[eventId]) return;
        const id = createHash('sha256').update(eventId).digest('hex').slice(0, 32);
        this.engine.state.seen[eventId] = { reply: e.message, at: this.now() };
        this.engine.state.outbox.push({ id, space: command.space, thread: command.thread, text: e.message });
        this.engine.store.save();
      });
    }
  }
  async flush() {
    // Same engine lock prevents a save from losing queue/outbox updates.
    await this.engine.serial(async () => {
      while (this.engine.state.outbox.length) {
        const item = this.engine.state.outbox[0];
        const params = new URLSearchParams({ messageId: `client-${item.id}`, messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' });
        const token = await this.auth.token('https://www.googleapis.com/auth/chat.bot');
        const response = await this.fetcher(`https://chat.googleapis.com/v1/${item.space}/messages?${params}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: item.text.slice(0, 4000), ...(item.thread ? { thread: { name: item.thread } } : {}) }), signal: AbortSignal.timeout(12000) });
        check(response.ok || response.status === 409, 'CHAT_SEND', `Google Chat 응답 전송 실패: HTTP ${response.status}`, 502);
        // A deterministic client message ID makes retry after a crash harmless.
        this.engine.state.outbox.shift(); this.engine.store.save();
      }
    });
  }
  async cycle() {
    await this.flush();
    const result = await this.pubsub('pull', { maxMessages: 1 });
    for (const item of result.receivedMessages || []) {
      await this.pubsub('modifyAckDeadline', { ackIds: [item.ackId], ackDeadlineSeconds: 120 });
      await this.receive(item);
      await this.pubsub('acknowledge', { ackIds: [item.ackId] });
      await this.flush();
    }
  }
  async start() {
    this.running = true;
    let backoff = 1000;
    while (this.running) {
      try { await this.cycle(); backoff = 1000; }
      catch (e) { this.log(`Google 연동 일시 중단: ${e.code || 'NETWORK'}. 재시도합니다.`); backoff = Math.min(backoff * 2, 30000); }
      if (this.running) await delay(backoff);
    }
  }
  stop() { this.running = false; }
}
