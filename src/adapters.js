import { randomUUID } from 'node:crypto';
import { JsonSocket } from './socket.js';
import { check, jsonFetch, watchUrl } from './util.js';

export class BrowserAdapter {
  type = 'browser';
  info() { return { type: this.type, automaticQueue: true, nativeApp: false, verification: 'player-events' }; }
  async play() { return { confirmed: false }; }
  async stop() {}
}
export class SamsungAdapter {
  type = 'samsung';
  constructor(config, { socketFactory = (url, opts) => new JsonSocket(url, opts), savePairing = () => {} } = {}) { this.config = config; this.socketFactory = socketFactory; this.savePairing = savePairing; }
  info() { return { type: this.type, automaticQueue: false, nativeApp: true, verification: 'manual', experimental: true }; }
  async session(action) {
    const c = this.config;
    const url = new URL(c.url);
    url.pathname = '/api/v2/channels/samsung.remote.control';
    url.searchParams.set('name', Buffer.from('Office Jukebox').toString('base64'));
    if (c.token) url.searchParams.set('token', c.token);
    const ws = this.socketFactory(url.toString(), { fingerprint: c.fingerprint, timeout: c.timeout || 10000 });
    try {
      await ws.connect();
      const hello = await ws.wait(x => ['ms.channel.connect', 'ms.channel.unauthorized', 'ms.channel.timeOut'].includes(x.event));
      check(hello.event === 'ms.channel.connect', 'PAIRING', 'TV에서 연결을 허용해야 합니다.', 502);
      if (hello.data?.token) this.savePairing({ token: hello.data.token });
      await action(ws);
      return { confirmed: false };
    } finally { ws.close(); }
  }
  async play(track) {
    check(this.config.experimentalVideoLaunch === true, 'UNVERIFIED_VIDEO_LAUNCH', '삼성 영상 링크 실행은 실험 기능입니다. 현장 검증 후 experimentalVideoLaunch를 켜세요.');
    return this.session(async ws => {
      await ws.send({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: this.config.appId || '111299001912', action_type: 'DEEP_LINK', metaTag: watchUrl(track.videoId) } } });
      // Samsung's remote channel does not guarantee an app/video playback acknowledgement.
    });
  }
  async stop() { return this.session(async ws => ws.send({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_STOP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } })); }
}
export class LgAdapter {
  type = 'lg';
  constructor(config, { socketFactory = (url, opts) => new JsonSocket(url, opts), savePairing = () => {} } = {}) { this.config = config; this.socketFactory = socketFactory; this.savePairing = savePairing; }
  info() { return { type: this.type, automaticQueue: false, nativeApp: true, verification: 'manual', experimental: true }; }
  async session(uri, payload) {
    const c = this.config;
    const ws = this.socketFactory(c.url, { fingerprint: c.fingerprint, timeout: c.timeout || 10000 });
    try {
      await ws.connect();
      await ws.send({ id: 'register', type: 'register', payload: { forcePairing: false, pairingType: 'PROMPT', 'client-key': c.clientKey || '', manifest: { manifestVersion: 1, appVersion: '1.0', permissions: ['LAUNCH', 'CONTROL_AUDIO', 'CONTROL_MEDIA_PLAYBACK'] } } });
      const hello = await ws.wait(x => x.type === 'registered' || x.type === 'error', c.pairingTimeout || 30000);
      check(hello.type === 'registered', 'PAIRING', 'LG 기기에서 연결을 허용해야 합니다.', 502);
      if (hello.payload?.['client-key']) this.savePairing({ clientKey: hello.payload['client-key'] });
      const id = randomUUID();
      await ws.send({ id, type: 'request', uri: `ssap://${uri}`, payload });
      const result = await ws.wait(x => x.id === id);
      check(result.type !== 'error' && result.payload?.returnValue !== false, 'DEVICE_REJECTED', '기기가 명령을 거부했습니다.', 502);
      return { confirmed: false };
    } finally { ws.close(); }
  }
  async play(track) {
    check(this.config.experimentalVideoLaunch === true, 'UNVERIFIED_VIDEO_LAUNCH', 'LG 영상 링크 실행은 실험 기능입니다. 현장 검증 후 experimentalVideoLaunch를 켜세요.');
    return this.session('system.launcher/launch', { id: this.config.appId || 'youtube.leanback.v4', params: { contentId: watchUrl(track.videoId) } });
  }
  async stop() { return this.session('media.controls/stop', {}); }
}
export class AndroidHaAdapter {
  type = 'android-ha';
  constructor(config, { fetcher = fetch } = {}) { this.config = config; this.fetcher = fetcher; }
  info() { return { type: this.type, automaticQueue: false, nativeApp: true, verification: 'manual', requires: 'Home Assistant Android TV Remote' }; }
  async call(service, data) {
    const c = this.config;
    check(/^remote\.[a-z0-9_]+$/.test(c.entityId || ''), 'ENTITY', 'Android TV Remote의 remote 엔티티가 필요합니다.');
    const url = new URL(c.url);
    check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'HA_URL', '올바른 Home Assistant 주소가 필요합니다.');
    await jsonFetch(new URL(`/api/services/remote/${service}`, url), { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ entity_id: c.entityId, ...data }) }, this.fetcher);
    return { confirmed: false };
  }
  async play(track) { return this.call('turn_on', { activity: watchUrl(track.videoId) }); }
  async stop() { return this.call('send_command', { command: 'MEDIA_STOP' }); }
}
export function createAdapter(config, dependencies = {}) {
  switch (config.type) {
    case 'browser': return new BrowserAdapter();
    case 'samsung': return new SamsungAdapter(config, dependencies);
    case 'lg': return new LgAdapter(config, dependencies);
    case 'android-ha': return new AndroidHaAdapter(config, dependencies);
    default: throw new Error(`지원하지 않는 재생 방식: ${config.type}. 일반 모니터는 browser + HDMI를 사용하세요.`);
  }
}
