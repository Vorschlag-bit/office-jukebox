import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, SamsungAdapter, LgAdapter, AndroidHaAdapter } from '../src/adapters.js';
import { AppError } from '../src/util.js';

const track = { videoId: 'dQw4w9WgXcQ' };
function samsungFake(event = { event: 'ms.channel.connect', data: { token: 'pair-token' } }) {
  const sent = []; let closed = false, usedUrl;
  return { sent, get closed() { return closed; }, get url() { return usedUrl; }, socketFactory: url => { usedUrl = url; return { connect: async () => {}, wait: async () => event, send: async x => sent.push(x), close: () => { closed = true; } }; } };
}
test('Samsung Tizen ws profile: pairing token + configured app ID + unconfirmed result', async () => {
  const mock = samsungFake(); let saved;
  const adapter = new SamsungAdapter({ url: 'ws://192.0.2.1:8001', appId: 'custom-app', experimentalVideoLaunch: true }, { ...mock, savePairing: x => { saved = x; } });
  assert.equal((await adapter.play(track)).confirmed, false);
  assert.equal(saved.token, 'pair-token'); assert.equal(mock.sent[0].params.data.appId, 'custom-app');
  assert.equal(mock.sent[0].params.data.metaTag, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(mock.closed, true); assert.equal(adapter.info().automaticQueue, false);
});
test('Samsung TLS profile: pin passed to transport, saved pairing token reused', async () => {
  const mock = samsungFake(); let options;
  const adapter = new SamsungAdapter({ url: 'wss://192.0.2.1:8002', token: 'old-token', fingerprint: 'ab'.repeat(32), experimentalVideoLaunch: true }, { socketFactory: (url, opts) => { options = opts; return mock.socketFactory(url); } });
  await adapter.play(track);
  assert.equal(new URL(mock.url).searchParams.get('token'), 'old-token'); assert.equal(options.fingerprint, 'ab'.repeat(32));
});
for (const event of ['ms.channel.unauthorized', 'ms.channel.timeOut']) test(`Samsung denied/expired pairing: ${event}`, async () => {
  const mock = samsungFake({ event });
  const adapter = new SamsungAdapter({ url: 'ws://192.0.2.1:8001', experimentalVideoLaunch: true }, mock);
  await assert.rejects(adapter.play(track), { code: 'PAIRING' }); assert.equal(mock.sent.length, 0); assert.equal(mock.closed, true);
});
test('Samsung video launch is opt-in, unsupported firmware does not look successful', async () => {
  const adapter = new SamsungAdapter({ url: 'ws://192.0.2.1:8001' }); await assert.rejects(adapter.play(track), { code: 'UNVERIFIED_VIDEO_LAUNCH' });
});
test('Samsung stop uses STOP key rather than power-off', async () => {
  const mock = samsungFake(); await new SamsungAdapter({ url: 'ws://192.0.2.1:8001' }, mock).stop();
  assert.equal(mock.sent[0].params.DataOfCmd, 'KEY_STOP');
});
function lgFake({ denyPairing = false, rejectLaunch = false } = {}) {
  const sent = []; let closed = false;
  return { sent, get closed() { return closed; }, socketFactory: () => ({ connect: async () => {}, send: async x => sent.push(x), wait: async () => sent.length === 1 ? denyPairing ? { type: 'error' } : { type: 'registered', payload: { 'client-key': 'new-client-key' } } : { id: sent.at(-1).id, type: rejectLaunch ? 'error' : 'response', payload: { returnValue: !rejectLaunch } }, close: () => { closed = true; } }) };
}
test('LG webOS profile: pairing key, app deep-link and command ACK remain unconfirmed', async () => {
  const mock = lgFake(); let saved;
  const adapter = new LgAdapter({ url: 'ws://192.0.2.2:3000', clientKey: 'old', experimentalVideoLaunch: true }, { ...mock, savePairing: x => { saved = x; } });
  assert.equal((await adapter.play(track)).confirmed, false); assert.equal(saved.clientKey, 'new-client-key');
  assert.equal(mock.sent[0].payload['client-key'], 'old'); assert.equal(mock.sent[1].uri, 'ssap://system.launcher/launch');
  assert.equal(mock.sent[1].payload.id, 'youtube.leanback.v4'); assert.equal(mock.closed, true);
});
test('LG webOS pairing rejected', async () => {
  const mock = lgFake({ denyPairing: true }); await assert.rejects(new LgAdapter({ url: 'ws://192.0.2.2:3000', experimentalVideoLaunch: true }, mock).play(track), { code: 'PAIRING' }); assert.equal(mock.closed, true);
});
test('LG app missing or launch endpoint denied', async () => {
  const mock = lgFake({ rejectLaunch: true }); await assert.rejects(new LgAdapter({ url: 'ws://192.0.2.2:3000', experimentalVideoLaunch: true }, mock).play(track), { code: 'DEVICE_REJECTED' });
});
test('LG launch gated until onsite verification', async () => {
  await assert.rejects(new LgAdapter({ url: 'ws://192.0.2.2:3000' }).play(track), { code: 'UNVERIFIED_VIDEO_LAUNCH' });
});
test('LG stop has actual stop command', async () => {
  const mock = lgFake(); await new LgAdapter({ url: 'ws://192.0.2.2:3000' }, mock).stop(); assert.equal(mock.sent[1].uri, 'ssap://media.controls/stop');
});
for (const kind of ['samsung', 'lg']) test(`${kind}: offline TV or VLAN failure is propagated, socket closed`, async () => {
  let closed = false;
  const adapter = createAdapter({ type: kind, url: 'ws://192.0.2.1', experimentalVideoLaunch: true }, { socketFactory: () => ({ connect: async () => { throw new AppError('DEVICE_CONNECT', 'offline', 502); }, close: () => { closed = true; } }) });
  await assert.rejects(adapter.play(track), { code: 'DEVICE_CONNECT' }); assert.equal(closed, true);
});
test('Android TV / Google TV via HA uses documented deep link service', async () => {
  const calls = [];
  const adapter = new AndroidHaAdapter({ url: 'http://192.0.2.3:8123', token: 'ha-token', entityId: 'remote.android_tv' }, { fetcher: async (url, options) => { calls.push({ url: url.toString(), body: JSON.parse(options.body), auth: options.headers.Authorization }); return { ok: true, json: async () => [] }; } });
  assert.equal((await adapter.play(track)).confirmed, false); await adapter.stop();
  assert.equal(calls[0].url, 'http://192.0.2.3:8123/api/services/remote/turn_on'); assert.equal(calls[0].body.activity, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(calls[1].body.command, 'MEDIA_STOP'); assert.equal(calls[0].auth, 'Bearer ha-token'); assert.equal(adapter.info().automaticQueue, false);
});
test('Android wrong entity / missing Remote Service fails rather than inventing success', async () => {
  const a = new AndroidHaAdapter({ url: 'http://localhost:8123', entityId: 'media_player.tv' }); await assert.rejects(a.play(track), { code: 'ENTITY' });
  const b = new AndroidHaAdapter({ url: 'http://localhost:8123', entityId: 'remote.tv' }, { fetcher: async () => ({ ok: false, status: 404 }) }); await assert.rejects(b.play(track), { code: 'UPSTREAM' });
});
for (const type of ['orsay', 'netcast', 'dumb-monitor', 'unknown', 'android-tablet']) test(`unsupported profile fails explicitly: ${type}`, () => {
  assert.throws(() => createAdapter({ type }), /지원하지 않는/);
});
test('browser / HDMI profile is the fallback and has automatic queue', async () => {
  const a = createAdapter({ type: 'browser' }); assert.equal(a.info().automaticQueue, true); assert.equal(a.info().nativeApp, false); assert.equal((await a.play(track)).confirmed, false);
});
