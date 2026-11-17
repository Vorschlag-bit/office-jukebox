// Optional, undocumented YouTube TV remote protocol. No cookies, downloads, or ad controls.
// Protocol references and their limitations are recorded in docs/NATIVE-TV.md.
import { randomUUID } from 'node:crypto';
import { AppError, check, boundedText } from './util.js';

const BASE = 'https://www.youtube.com/api/lounge';
export class LoungeFrames {
  constructor(onEvent, maxBytes = 1048576) { this.onEvent = onEvent; this.maxBytes = maxBytes; this.buffer = Buffer.alloc(0); this.expected = null; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    check(this.buffer.length <= this.maxBytes + 100, 'LOUNGE_SIZE', 'TV 이벤트 버퍼 크기 초과', 502);
    while (true) {
      if (this.expected === null) {
        const line = this.buffer.indexOf(10); if (line < 0) { check(this.buffer.length < 32, 'LOUNGE_FORMAT', 'TV 이벤트 길이 형식 오류', 502); return; }
        const header = this.buffer.subarray(0, line).toString('ascii').trim(); this.buffer = this.buffer.subarray(line + 1);
        if (!header) continue;
        check(/^\d{1,8}$/.test(header), 'LOUNGE_FORMAT', 'TV 이벤트 길이 형식 오류', 502);
        this.expected = Number(header);
        check(this.expected > 0 && this.expected <= this.maxBytes, 'LOUNGE_SIZE', 'TV 이벤트 크기 초과', 502);
      }
      if (this.buffer.length < this.expected) return;
      const content = this.buffer.subarray(0, this.expected); this.buffer = this.buffer.subarray(this.expected); this.expected = null;
      let rows; try { rows = JSON.parse(content.toString('utf8')); } catch { throw new AppError('LOUNGE_FORMAT', 'TV 이벤트 JSON 오류', 502); }
      check(Array.isArray(rows), 'LOUNGE_FORMAT', 'TV 이벤트 배열이 필요합니다.', 502);
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(Number(row[0])) || !Array.isArray(row[1]) || typeof row[1][0] !== 'string') continue;
        this.onEvent({ id: Number(row[0]), name: row[1][0], args: row[1].slice(1) });
      }
    }
  }
}
async function loungeResponse(path, params, { method = 'POST', fetcher = fetch, signal = AbortSignal.timeout(12000), stream = false } = {}) {
  let response;
  try {
    response = await fetcher(`${BASE}/${path}`, { method, signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://www.youtube.com' }, ...(method === 'POST' ? { body: new URLSearchParams(params).toString() } : {}) });
  } catch (e) { if (signal.aborted) throw signal.reason; throw new AppError('LOUNGE_NETWORK', '유튜브 TV 연결 실패', 502); }
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new AppError(response.status === 401 ? 'LOUNGE_AUTH' : response.status === 400 || response.status === 410 ? 'LOUNGE_SESSION' : 'LOUNGE_HTTP', `유튜브 TV 연결 응답 오류: HTTP ${response.status}`, 502);
  }
  return stream ? response : boundedText(response);
}
export async function pairTvCode(code, { fetcher = fetch } = {}) {
  const normalized = String(code).replace(/[\s-]/g, '');
  check(/^\d{8,20}$/.test(normalized), 'TV_CODE', '유튜브 앱의 숫자로 된 TV 연결 코드를 입력하세요. 로그인 활성화 코드와 다릅니다.');
  const raw = await loungeResponse('pairing/get_screen', { pairing_code: normalized }, { fetcher });
  let result; try { result = JSON.parse(raw); } catch { throw new AppError('TV_CODE', 'TV 코드 연결 응답 형식이 변경됐습니다.', 502); }
  check(typeof result.screen?.screenId === 'string' && result.screen.screenId.length > 0 && result.screen.screenId.length <= 1024 && typeof result.screen?.loungeToken === 'string' && result.screen.loungeToken.length > 0 && result.screen.loungeToken.length <= 8192, 'TV_CODE', 'TV 코드가 만료됐거나 연결할 수 없습니다. 새 코드를 확인하세요.');
  return { screenId: result.screen.screenId, loungeToken: result.screen.loungeToken, deviceName: String(result.screen.name || 'YouTube TV').slice(0, 100) };
}
export class LoungeClient {
  constructor(config, { fetcher = fetch, savePairing = () => {}, onEvent = () => {} } = {}) {
    Object.assign(this, { config, fetcher, savePairing, onEvent });
    this.remoteId = config.remoteId || randomUUID(); this.aid = -1; this.sid = null; this.gsession = null; this.offset = 0; this.rid = 1; this.epoch = 0;
    this.commands = Promise.resolve();
  }
  async refresh() {
    check(this.config.screenId, 'TV_NOT_PAIRED', '먼저 pair-tv 명령으로 본인의 TV를 연결하세요.');
    const raw = await loungeResponse('pairing/get_lounge_token_batch', { screen_ids: this.config.screenId }, { fetcher: this.fetcher });
    let data; try { data = JSON.parse(raw); } catch { throw new AppError('LOUNGE_FORMAT', '유튜브 TV 토큰 응답 오류', 502); }
    const screen = data.screens?.find(x => x.screenId === this.config.screenId);
    check(screen?.loungeToken, 'TV_NOT_PAIRED', 'TV 연결이 해제됐습니다. 새 TV 코드로 다시 연결하세요.');
    this.config.loungeToken = screen.loungeToken; this.config.remoteId = this.remoteId;
    this.savePairing({ loungeToken: screen.loungeToken, remoteId: this.remoteId });
  }
  consume(event) {
    if (event.id <= this.aid) return; // AID redelivery must never advance the queue twice.
    this.aid = event.id;
    if (event.name === 'c') this.sid = String(event.args[0] || '');
    if (event.name === 'S') this.gsession = String(event.args[0] || '');
    this.onEvent(event);
  }
  async connect() {
    if (this.sid && this.gsession) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.refresh();
      this.epoch++; // Immediately invalidate any old backchannel still delivering frames.
      this.sid = null; this.gsession = null; this.aid = -1; this.offset = 0; this.rid = 1;
      const query = new URLSearchParams({ RID: String(this.rid++), VER: '8', CVER: '1', auth_failure_option: 'send_error' });
      const form = { app: 'web', 'mdx-version': '3', name: 'Office Jukebox', id: this.remoteId, device: 'REMOTE_CONTROL', capabilities: 'que,dsdtr,atp,vsp', magnaKey: 'cloudPairedDevice', ui: 'false', theme: 'cl', loungeIdToken: this.config.loungeToken };
      const text = await loungeResponse(`bc/bind?${query}`, form, { fetcher: this.fetcher });
      new LoungeFrames(event => this.consume(event)).push(Buffer.from(text));
      check(this.sid && this.gsession, 'TV_OFFLINE', 'TV 유튜브 앱의 연결을 확인할 수 없습니다. 앱을 열어 두세요.', 502);
      this.offset = 1;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  params() { return { name: 'Office Jukebox', loungeIdToken: this.config.loungeToken, SID: this.sid, AID: String(this.aid), gsessionid: this.gsession, device: 'REMOTE_CONTROL', app: 'youtube-desktop', VER: '8', v: '2' }; }
  async command(name, values = {}) {
    const work = this.commands.then(async () => {
      await this.connect();
      const epoch = this.epoch;
      const query = new URLSearchParams({ ...this.params(), RID: String(this.rid++) });
      const form = { count: '1', ofs: String(this.offset++), req0__sc: name };
      for (const [key, value] of Object.entries(values)) form[`req0_${key}`] = String(value);
      try {
        const reply = await loungeResponse(`bc/bind?${query}`, form, { fetcher: this.fetcher });
        // Command responses can carry state events too, not just the streaming GET.
        if (epoch === this.epoch && /^\s*\d+\n/.test(reply)) new LoungeFrames(event => this.consume(event)).push(Buffer.from(reply));
      }
      catch (error) { if (epoch === this.epoch) this.sid = null; throw error; }
      // HTTP acceptance is not playback confirmation. Never blindly replay a timed-out command.
      return { confirmed: false };
    });
    this.commands = work.catch(() => {}); return work;
  }
  async poll(signal) {
    await this.connect();
    const epoch = this.epoch;
    const query = new URLSearchParams({ ...this.params(), RID: 'rpc', CI: '0', TYPE: 'xmlhttp' });
    try {
      const response = await loungeResponse(`bc/bind?${query}`, {}, { fetcher: this.fetcher, method: 'GET', signal, stream: true });
      const parser = new LoungeFrames(event => { if (epoch === this.epoch) this.consume(event); });
      if (!response.body?.getReader) { parser.push(Buffer.from(await boundedText(response))); return; }
      const reader = response.body.getReader();
      try {
        while (!signal.aborted) { const { value, done } = await reader.read(); if (done) return; parser.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) { if (!signal.aborted && epoch === this.epoch) this.sid = null; throw error; }
  }
}
export class LoungeAdapter {
  type = 'lounge';
  constructor(config, dependencies = {}) {
    check(config.experimental === true, 'LOUNGE_OPT_IN', 'TV 코드 제어는 비공식 프로토콜입니다. 안내를 확인하고 experimental을 켜세요.');
    this.config = config; this.listener = () => {}; this.target = null; this.lastCpn = null; this.online = false; this.retiredCpns = new Set();
    this.autoplayMode = 'UNKNOWN'; this.policyError = null; this.statusQueries = 0;
    this.client = dependencies.client || new LoungeClient(config, { ...dependencies, onEvent: event => this.handle(event) });
    this.client.onEvent = event => this.handle(event);
    this.controller = new AbortController();
  }
  setListener(listener) { this.listener = listener; }
  info() { return { type: this.type, nativeApp: true, automaticQueue: true, verification: 'video-id-and-playback-nonce', experimental: true, online: this.online, autoplayMode: this.autoplayMode, policyError: this.policyError, statusQueries: this.statusQueries }; }
  emit(event, extra = {}) { if (this.target) this.listener({ sessionId: this.target.sessionId, videoId: this.target.videoId, event, ...extra }); }
  async disableAutoplay() {
    if (this.autoplayRequest) return this.autoplayRequest;
    this.autoplayRequest = this.client.command('setAutoplayMode', { autoplayMode: 'DISABLED' }).then(() => { this.policyError = null; }).catch(error => { this.policyError = error.code || 'AUTOPLAY_POLICY'; throw error; }).finally(() => { this.autoplayRequest = null; });
    return this.autoplayRequest;
  }
  startMonitoring() {
    if (!this.monitoring) { this.monitoring = true; void this.monitor(); }
    if (!this.statusTimer) {
      this.statusTimer = setInterval(() => { void this.requestStatus(); }, 3000);
      this.statusTimer.unref();
    }
  }
  async requestStatus() {
    if (this.statusRequest) return this.statusRequest;
    if (!this.target || this.controller.signal.aborted) return;
    this.statusQueries++;
    this.statusRequest = this.client.command('getNowPlaying').catch(() => {}).finally(() => { this.statusRequest = null; });
    return this.statusRequest;
  }
  handle(event) {
    if (this.controller.signal.aborted) return;
    if (event.name === 'onAutoplayModeChanged') {
      this.autoplayMode = event.args[0]?.autoplayMode === 'DISABLED' ? 'DISABLED' : event.args[0]?.autoplayMode === 'ENABLED' ? 'ENABLED' : 'UNKNOWN';
      if (this.autoplayMode === 'ENABLED' && this.target) void this.disableAutoplay().catch(() => {});
      return;
    }
    if (event.name === 'loungeScreenDisconnected') { this.online = false; this.emit('offline'); this.client.sid = null; return; }
    const target = this.target, payload = event.args[0];
    // AID restarts at zero after a new BrowserChannel session. Old sessions are
    // already fenced by LoungeClient. Do not discard the new session forever.
    if (target && target.epoch !== this.client.epoch) { target.epoch = this.client.epoch; target.afterAid = -1; target.idleQuery = null; target.liveEpoch = null; }
    if (!target || !payload || typeof payload !== 'object' || event.id <= target.afterAid) return;
    if (event.name === 'adPlaying' || event.name === 'onAdStateChange') {
      const state = Number(payload.adState);
      target.adActive = ![0, -1].includes(state); target.idleQuery = null; return;
    }
    if (event.name === 'nowPlaying') {
      // Some receivers clear the item completely at its end: nowPlaying {}.
      // Confirm that actual idle snapshot on a later explicit query, after this
      // session observed playback. Never use duration/elapsed time as an end.
      if (!payload.videoId && !payload.cpn && (payload.state === undefined || Number(payload.state) === 0)) {
        if (target.playing && target.lastState === 1 && target.liveEpoch === this.client.epoch && !target.adActive && !target.finished) {
          if (target.idleQuery !== null && target.idleQuery !== undefined && this.statusQueries > target.idleQuery) {
            target.finished = true; this.emit('idle', { verifiedObservation: true });
          } else if (target.idleQuery === null || target.idleQuery === undefined) target.idleQuery = this.statusQueries;
        }
        return;
      }
      target.idleQuery = null;
      if (/^[A-Za-z0-9_-]{11}$/.test(payload.videoId || '') && typeof payload.cpn === 'string' && payload.cpn.length > 0 && payload.cpn.length <= 256 && !this.retiredCpns.has(payload.cpn) && [1,2,3].includes(Number(payload.state)) && (target.playing || target.observing) && (payload.videoId !== target.videoId || target.cpn && payload.cpn !== target.cpn)) {
        // Rebase observation only. Never play, seek or consume a queued request.
        if (target.cpn) this.retiredCpns.add(target.cpn);
        if (this.retiredCpns.size > 64) this.retiredCpns.delete(this.retiredCpns.values().next().value);
        const observationSessionId = randomUUID();
        this.emit('external', { verifiedObservation: true, observedVideoId: payload.videoId, observationSessionId, observedState: Number(payload.state), ...this.position(payload) });
        this.target = { sessionId: observationSessionId, videoId: payload.videoId, afterAid: event.id - 1, epoch: this.client.epoch, previousCpn: null, cpn: payload.cpn, playing: false, finished: false, observing: true };
        this.handle(event); return;
      }
      if (payload.cpn && this.retiredCpns.has(payload.cpn)) return;
      if (payload.videoId !== target.videoId || !payload.cpn || payload.cpn === target.previousCpn) return;
      target.cpn = String(payload.cpn);
    } else if (event.name !== 'onStateChange') return;
    // onStateChange lacks videoId. Only a matching playback nonce may complete this request.
    if (!target.cpn || payload.cpn !== target.cpn || (payload.videoId && payload.videoId !== target.videoId)) return;
    const progress = this.position(payload);
    if (!target.adActive && Object.keys(progress).length) this.emit('position', { verifiedObservation: true, ...progress });
    const state = Number(payload.state);
    target.lastState = state; target.idleQuery = null;
    if (state === 1) { target.playing = true; target.liveEpoch = this.client.epoch; this.online = true; this.lastCpn = target.cpn; this.emit('playing', { verifiedObservation: true }); }
    else if (state === 2 && target.observing) { this.online = true; this.emit('paused', { verifiedObservation: true }); }
    else if (state === 2 && target.playing) this.emit('paused');
    else if (state === 3 && target.playing) this.emit('buffering');
    else if (state === 0 && target.playing && !target.finished) { target.finished = true; this.emit('ended', { verifiedObservation: true }); }
  }
  position(payload) {
    const value = key => (typeof payload[key] === 'string' || typeof payload[key] === 'number') && String(payload[key]).trim() !== '' && Number.isFinite(Number(payload[key])) && Number(payload[key]) >= 0 && Number(payload[key]) <= 604800 ? Number(payload[key]) : undefined;
    return Object.fromEntries(Object.entries({positionSeconds: value('currentTime'), durationSeconds: value('duration')}).filter(([,value])=>value !== undefined));
  }
  async play(track) {
    check(!this.controller.signal.aborted, 'ADAPTER_CLOSED', '종료 중인 재생기입니다.');
    await this.client.connect();
    check(!this.controller.signal.aborted, 'ADAPTER_CLOSED', '종료 중인 재생기입니다.');
    await this.disableAutoplay();
    this.target = { sessionId: track.sessionId, videoId: track.videoId, afterAid: this.client.aid, epoch: this.client.epoch, previousCpn: this.lastCpn, cpn: null, playing: false, finished: false };
    const result = await this.client.command('setPlaylist', { videoId: track.videoId, videoIds: track.videoId, currentIndex: 0, currentTime: Number.isFinite(track.resumePositionSeconds) && track.resumePositionSeconds >= 0 && track.resumePositionSeconds <= 604800 ? track.resumePositionSeconds : 0 });
    this.startMonitoring();
    await this.disableAutoplay().catch(() => {});
    void this.requestStatus();
    return result;
  }
  async attach(track) {
    check(!this.controller.signal.aborted, 'ADAPTER_CLOSED', '종료 중인 재생기입니다.');
    await this.client.connect();
    // Observe the already-playing item after restart; never issue play/seek here.
    this.target = { sessionId: track.sessionId, videoId: track.videoId, afterAid: this.client.aid, epoch: this.client.epoch, previousCpn: null, cpn: null, playing: false, finished: false, observing: true };
    this.startMonitoring();
    await this.disableAutoplay().catch(() => {});
    await this.requestStatus();
  }
  async monitor() {
    let backoff = 1000;
    while (!this.controller.signal.aborted) {
      const epoch = this.client.epoch;
      const timeout = AbortSignal.timeout(45000);
      try { await this.client.poll(AbortSignal.any([this.controller.signal, timeout])); backoff = 1000; }
      catch {
        if (this.controller.signal.aborted) break;
        if (!timeout.aborted) { this.online = false; this.emit('offline'); if (epoch === this.client.epoch) this.client.sid = null; backoff = Math.min(backoff * 2, 30000); }
      }
      if (!this.controller.signal.aborted) await new Promise(resolve => { const timer = setTimeout(resolve, backoff); const abort = () => { clearTimeout(timer); resolve(); }; this.controller.signal.addEventListener('abort', abort, { once: true }); setTimeout(() => this.controller.signal.removeEventListener('abort', abort), backoff + 1).unref(); });
    }
    this.monitoring = false;
  }
  async pause() { return this.client.command('pause'); }
  async resume() { return this.client.command('play'); }
  async stop() { const result = await this.client.command('pause'); this.target = null; return result; }
  close() { this.target = null; clearInterval(this.statusTimer); this.controller.abort(); }
}
