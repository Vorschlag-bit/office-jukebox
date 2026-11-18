import { createHmac, createHash, randomUUID } from 'node:crypto';
import { GoogleWorker } from './google.js';
import { AppError, check, boundedText } from './util.js';

export function validateBridge(config) {
  check(config.transport === 'apps-script' && !config.subscription && !config.serviceAccountFile, 'COST_POLICY', 'Pub/Sub·서비스 계정 실행 경로는 차단됩니다. Apps Script 설정으로 이전하세요.');
  check(/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(config.scriptUrl || ''), 'CONFIG', 'Apps Script 웹 앱의 /exec HTTPS URL이 필요합니다.');
  check(typeof config.sharedSecret === 'string' && config.sharedSecret.length >= 32 && !config.sharedSecret.includes('REPLACE'), 'CONFIG', '32자 이상의 별도 Apps Script 공유 비밀이 필요합니다.');
  check(Number.isInteger(config.pollIntervalMs ?? 5000) && (config.pollIntervalMs ?? 5000) >= 5000 && (config.pollIntervalMs ?? 5000) <= 60000, 'CONFIG', '폴링 간격은 5000~60000ms로 설정하세요.');
}

export class AppsScriptWorker extends GoogleWorker {
  constructor(options) { super(options); this.clientId = randomUUID(); this.health.transport = 'apps-script'; this.publicUrl = options.publicUrl || null; }
  async bridge(op, data = {}) {
    const payload = JSON.stringify(data), ts = this.now(), nonce = randomUUID();
    const signature = createHmac('sha256', this.config.sharedSecret).update(`1\n${ts}\n${nonce}\n${op}\n${payload}`).digest('hex');
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(12000)]);
    let url = this.config.scriptUrl, options = { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, ts, nonce, op, payload, signature }), signal };
    try {
      for (let count = 0; count < 4; count++) {
        const response = await this.fetcher(url, options);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = new URL(response.headers.get('location'), url);
          await response.body?.cancel?.();
          // ContentService redirects to a one-time Google content URL. Never forward signed bodies.
          check([302, 303].includes(response.status) && next.protocol === 'https:' && next.hostname === 'script.googleusercontent.com' && !next.username && !next.password && !next.port, 'BRIDGE_REDIRECT', '예상하지 않은 Apps Script 리디렉션입니다.', 502);
          url = next.href; options = { method: 'GET', redirect: 'manual', signal }; continue;
        }
        check(response.ok, 'BRIDGE_HTTP', 'Apps Script 웹 앱 배포 권한 또는 할당량을 확인하세요.', 502);
        let result;
        try { result = JSON.parse(await boundedText(response, 65536)); } catch { throw new AppError('BRIDGE_FORMAT', 'JSON 응답이 아닙니다. 로그인 페이지·배포 설정·할당량을 확인하세요.', 502); }
        check(result?.ok === true, 'BRIDGE_REJECTED', 'Apps Script가 요청을 거부했습니다. 공유 비밀·허용 목록·중복 worker·시계를 확인하세요.', 502);
        return result;
      }
      throw new AppError('BRIDGE_REDIRECT', '리디렉션 제한 초과', 502);
    } catch (e) { if (e instanceof AppError) throw e; throw new AppError('BRIDGE_NETWORK', 'Apps Script 연결 실패', 502); }
  }
  async check() {
    const r = await this.bridge('check');
    check(r.protocol === 1, 'BRIDGE_CONFIG', '중계 프로토콜 버전이 다릅니다. Apps Script를 업데이트하세요.');
    check(Array.isArray(r.allowedSpaces) && this.config.allowedSpaces.every(s => r.allowedSpaces.includes(s)), 'BRIDGE_CONFIG', '양쪽 허용 스페이스 설정이 다릅니다.');
    return { ok: true, transport: 'apps-script', protocol: r.protocol, allowedSpaceCount: r.allowedSpaces.length, billingVerified: false, hardwareVerified: false };
  }
  async flushBatch() {
    for (let i = 0; i < 3; i++) {
      const item = await this.engine.serial(async () => structuredClone(this.engine.state.outbox.find(x => !x.nextAttemptAt || x.nextAttemptAt <= this.now())));
      if (!item) return;
      if (!this.config.allowedSpaces.includes(item.space) || !/^users\/[A-Za-z0-9_-]+$/.test(item.user || '')) {
        await this.engine.serial(async () => { this.engine.state.outbox = this.engine.state.outbox.filter(x => x.id !== item.id); this.engine.state.deadLetters.push({ ...item, failure: 'BRIDGE_RECIPIENT', failedAt: this.now() }); this.engine.state.deadLetters = this.engine.state.deadLetters.slice(-100); this.engine.store.save(); });
        continue;
      }
      try { await this.bridge('result', { id: item.id, space: item.space, user: item.user, text: String(item.text).slice(0, 1500) }); }
      catch (e) { await this.deferReply(item, e.code); throw e; }
      await this.engine.serial(async () => { this.engine.state.outbox = this.engine.state.outbox.filter(x => x.id !== item.id); this.engine.store.save(); });
      this.health.lastSendAt = this.now();
    }
  }
  async cycle() {
    try { await this.flush(); } catch { /* Receive independently from result retries. */ }
    if (this.engine.state.outbox.length >= 500) return;
    const snapshot = this.engine.snapshot();
    const view = { current: snapshot.current ? { title: snapshot.current.title.slice(0, 180), status: snapshot.current.status } : null,
      queue: snapshot.queue.slice(0, 8).map(x => ({ id: x.id, title: x.title.slice(0, 180) })), queueCount: snapshot.queue.length,
      memberPlaybackControls: this.config.memberPlaybackControls === true, paused: snapshot.paused, searchEnabled: !!this.engine.youtube.key, playerOnline: snapshot.player.online, webUrl: this.publicUrl };
    const songs = snapshot.queue.map(x => ({ id: x.id, title: [...x.title].slice(0, 80).join('') }));
    const revision = createHash('sha256').update(JSON.stringify(songs)).digest('hex');
    const queueView = this.queueRevision === revision ? undefined : { revision, songs };
    const result = await this.bridge('pull', { clientId: this.clientId, view, queueView });
    if (result.queueRevision === revision) this.queueRevision = revision;
    else this.queueRevision = null;
    const c = result.command;
    if (!c) return;
    check(typeof c.id === 'string' && c.id.length <= 150 && typeof c.lease === 'string' && c.lease.length <= 100 && typeof c.text === 'string' && c.text.length <= 500 && /^users\/[A-Za-z0-9_-]+$/.test(c.user || '') && this.config.allowedSpaces.includes(c.space) && Number.isFinite(c.at), 'BRIDGE_COMMAND', '잘못된 중계 명령입니다.', 502);
    // Reuse durable Google event processing, operator checks, age checks and poison handling.
    await this.receive({ message: { data: Buffer.from(JSON.stringify({ type: 'MESSAGE', eventTime: new Date(c.at).toISOString(), space: { name: c.space }, user: { name: c.user }, message: { name: c.id, argumentText: c.text, sender: { name: c.user, type: 'HUMAN' } } })).toString('base64') } });
    await this.bridge('ack', { clientId: this.clientId, id: c.id, lease: c.lease });
    try { await this.flush(); } catch { /* Durable result remains queued. */ }
  }
  async start() {
    this.running = true;
    let interval = this.config.pollIntervalMs ?? 5000;
    while (this.running) {
      try { await this.cycle(); this.health.connected = true; this.health.lastError = null; interval = this.config.pollIntervalMs ?? 5000; }
      catch (e) { this.health.connected = false; this.health.lastError = e.code || 'BRIDGE_NETWORK'; this.log(`Apps Script 연동 일시 중단: ${this.health.lastError}`); interval = Math.min(60000, interval * 2); }
      if (this.running) await new Promise(resolve => { const timer = setTimeout(resolve, interval); this.wake = () => { clearTimeout(timer); resolve(); }; });
    }
  }
}
