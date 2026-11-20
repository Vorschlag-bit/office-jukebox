import { createSign, createHash } from 'node:crypto';
import { check, jsonFetch } from './util.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export class ServiceAccountAuth {
  constructor(credentials, { fetcher = fetch, now = Date.now } = {}) { this.credentials = credentials; this.fetcher = fetcher; this.now = now; this.tokens = new Map(); }
  invalidate(scope) { this.tokens.delete(scope); }
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
  constructor({ config, auth, engine, fetcher = fetch, now = Date.now, log = console.warn }) {
    Object.assign(this, { config, auth, engine, fetcher, now, log }); this.running = false;
    this.health = { connected: false, lastReceiveAt: null, lastSendAt: null, lastError: null };
    this.controller = new AbortController();
  }
  async request(scope, url, body) {
    return jsonFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${await this.auth.token(scope)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(12000)]) }, this.fetcher);
  }
  async pubsub(method, body) {
    check(/^projects\/[A-Za-z0-9_-]+\/subscriptions\/[A-Za-z0-9_.~-]+$/.test(this.config.subscription || ''), 'SUBSCRIPTION', '올바른 Pub/Sub subscription 이름이 필요합니다.');
    return this.request('https://www.googleapis.com/auth/pubsub', `https://pubsub.googleapis.com/v1/${this.config.subscription}:${method}`, body);
  }
  async receive(item, { includeChoices = false, selectionId } = {}) {
    if (!item?.message) return;
    const raw = item.message;
    if (typeof raw.data !== 'string' || raw.data.length > 65536) return;
    let event;
    try { event = JSON.parse(Buffer.from(raw.data || '', 'base64').toString('utf8')); }
    catch { return; } // poison message: acknowledge, do not retry forever.
    let command;
    try { command = normalizeChatEvent(event); } catch { return; }
    if (!command || !this.config.allowedSpaces.includes(command.space)) return;
    this.health.lastReceiveAt = this.now();
    // Pub/Sub redelivery after a long outage must not suddenly play yesterday's request.
    const timestamp = Date.parse(command.eventTime || raw.publishTime || '');
    if (!Number.isFinite(timestamp) || this.now() - timestamp > 300000 || timestamp - this.now() > 60000) return;
    const eventId = command.name || `pubsub:${raw.messageId}`;
    check(eventId && !eventId.endsWith('undefined'), 'EVENT_ID', '메시지 식별자가 없습니다.');
    try {
      await this.engine.command({ ...command, eventId, includeChoices, selectionId, operator: this.config.operatorUsers.includes(command.user), playbackControl: this.config.memberPlaybackControls === true });
    } catch (e) {
      // User errors are durable replies; transient provider errors are retried by Pub/Sub.
      if (!e.status || e.status >= 500 && !(includeChoices && ['NETWORK', 'UPSTREAM', 'UPSTREAM_FORMAT', 'YOUTUBE_KEY_INVALID'].includes(e.code))) throw e;
      await this.engine.serial(async () => {
        if (Object.hasOwn(this.engine.state.seen, eventId)) return;
        check(this.engine.state.outbox.length < 500, 'NOTIFICATIONS_FULL', '응답 대기열이 가득 찼습니다.', 503);
        const id = createHash('sha256').update(eventId).digest('hex').slice(0, 32);
        Object.defineProperty(this.engine.state.seen, eventId, { value: { reply: e.message, at: this.now() }, writable: true, enumerable: true, configurable: true });
        const ids = Object.keys(this.engine.state.seen);
        for (const key of ids.slice(0, Math.max(0, ids.length - 5000))) delete this.engine.state.seen[key];
        this.engine.state.outbox.push({ id, space: command.space, user: command.user, thread: command.thread, text: e.message, commandId: eventId });
        this.engine.store.save();
      });
    }
  }
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushBatch().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async flushBatch() {
      // Do network I/O outside the engine lock: Chat outages must not freeze local controls.
      for (let sent = 0; sent < 3; sent++) {
        const item = await this.engine.serial(async () => structuredClone(this.engine.state.outbox.find(x => !x.nextAttemptAt || x.nextAttemptAt <= this.now())));
        if (!item) return;
        const params = new URLSearchParams({ messageId: `client-${item.id}`, messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' });
        let response;
        try {
          const token = await this.auth.token('https://www.googleapis.com/auth/chat.bot');
          response = await this.fetcher(`https://chat.googleapis.com/v1/${item.space}/messages?${params}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: safeChatText(item.text).slice(0, 4000), ...(item.thread ? { thread: { name: item.thread } } : {}) }), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(12000)]) });
        } catch {
          await this.deferReply(item, 'CHAT_NETWORK');
          check(false, 'CHAT_SEND', 'Google Chat 응답 연결 실패. 명령 수신은 계속합니다.', 502);
        }
        // Drain or cancel every response, including failures, to release pooled connections.
        await response.body?.cancel?.().catch(() => {});
        if (response.status === 401) this.auth.invalidate?.('https://www.googleapis.com/auth/chat.bot');
        const delivered = response.ok || response.status === 409;
        const permanent = [400, 403, 404].includes(response.status);
        if (delivered || permanent) {
          await this.engine.serial(async () => {
            this.engine.state.outbox = this.engine.state.outbox.filter(x => x.id !== item.id);
            if (permanent) {
              this.engine.state.deadLetters ||= [];
              this.engine.state.deadLetters.push({ ...item, failure: `CHAT_HTTP_${response.status}`, failedAt: this.now() });
              this.engine.state.deadLetters = this.engine.state.deadLetters.slice(-100);
              this.health.lastError = `CHAT_HTTP_${response.status}`;
            } else { this.health.lastSendAt = this.now(); this.health.lastError = null; }
            this.engine.store.save();
          });
        } else {
          await this.deferReply(item, `CHAT_HTTP_${response.status}`);
          check(false, 'CHAT_SEND', `Google Chat 응답 전송 실패: HTTP ${response.status}`, 502);
        }
      }
  }
  async deferReply(item, code) {
    this.health.lastError = code;
    await this.engine.serial(async () => {
      const queued = this.engine.state.outbox.find(x => x.id === item.id);
      if (queued) { queued.attempts = (queued.attempts || 0) + 1; queued.nextAttemptAt = this.now() + Math.min(300000, 1000 * 2 ** Math.min(queued.attempts, 8)); this.engine.store.save(); }
    });
  }
  async cycle() {
    try { await this.flush(); } catch { /* Reply failures are recorded; receiving stays available. */ }
    if (this.engine.state.outbox.length >= 500) return;
    const result = await this.pubsub('pull', { maxMessages: 1 });
    for (const item of result.receivedMessages || []) {
      await this.pubsub('modifyAckDeadline', { ackIds: [item.ackId], ackDeadlineSeconds: 120 });
      await this.receive(item);
      await this.pubsub('acknowledge', { ackIds: [item.ackId] });
      try { await this.flush(); } catch { /* Retried independently. */ }
    }
  }
  async start() {
    this.running = true;
    let backoff = 1000;
    while (this.running) {
      try { await this.cycle(); backoff = 1000; this.health.connected = true; }
      catch (e) { this.health.connected = false; this.health.lastError = e.code || 'NETWORK'; this.log(`Google 연동 일시 중단: ${e.code || 'NETWORK'}. 재시도합니다.`); backoff = Math.min(backoff * 2, 30000); }
      if (this.running) await new Promise(resolve => { const timer = setTimeout(resolve, backoff); this.wake = () => { clearTimeout(timer); resolve(); }; });
    }
  }
  stop() { this.running = false; this.controller.abort(); this.wake?.(); }
}
export function safeChatText(text) { return String(text).replaceAll('<', '‹').replaceAll('>', '›'); }
