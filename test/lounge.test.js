import test from 'node:test';
import assert from 'node:assert/strict';
import { LoungeFrames, LoungeClient, LoungeAdapter, pairTvCode } from '../src/lounge.js';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';

function framed(events) { const bytes = Buffer.from(JSON.stringify(events)); return Buffer.concat([Buffer.from(`${bytes.length}\n`), bytes]); }
const response = text => new Response(text, { status: 200 });
test('Lounge parses UTF-8 length-prefixed events across every byte boundary', () => {
  const events = []; const parser = new LoungeFrames(x => events.push(x));
  const data = framed([[1, ['nowPlaying', { title: '한글 🎵', videoId: 'dQw4w9WgXcQ' }]], [2, ['noop']]]);
  for (const b of data) parser.push(Buffer.from([b]));
  assert.equal(events.length, 2); assert.equal(events[0].args[0].title, '한글 🎵');
});
test('Lounge handles adjacent chunks and incomplete chunk without inventing events', () => {
  const events = [], parser = new LoungeFrames(x => events.push(x));
  const a = framed([[1, ['c', 'session']]]), b = framed([[2, ['S', 'google-session']]]);
  parser.push(Buffer.concat([a, b.subarray(0, b.length - 1)])); assert.equal(events.length, 1);
  parser.push(b.subarray(b.length - 1)); assert.equal(events.length, 2);
});
for (const bad of ['99999999\n', 'x\n', '-1\n', '2\n{}', '4\nnope']) test(`Lounge rejects malformed or oversized framing: ${bad.trim()}`, () => {
  assert.throws(() => new LoungeFrames(() => {}).push(Buffer.from(bad)));
});
test('TV code pairing uses fixed HTTPS endpoint, never browser cookies or arbitrary URLs', async () => {
  const paired = await pairTvCode('1234-5678 9012', { fetcher: async (url, options) => {
    assert.equal(url, 'https://www.youtube.com/api/lounge/pairing/get_screen'); assert.equal(options.method, 'POST');
    assert.equal(new URLSearchParams(options.body).get('pairing_code'), '123456789012'); assert.equal(options.headers.Cookie, undefined);
    return response(JSON.stringify({ screen: { screenId: 'screen-test', loungeToken: 'token-test', name: 'Test TV' } }));
  } });
  assert.equal(paired.screenId, 'screen-test');
});
test('expired and login activation codes rejected without guessing more codes', async () => {
  let calls = 0; const fetcher = async () => { calls++; return response('{}'); };
  await assert.rejects(pairTvCode('ABCD-EFGH', { fetcher }), { code: 'TV_CODE' }); assert.equal(calls, 0);
  await assert.rejects(pairTvCode('123456789012', { fetcher }), { code: 'TV_CODE' }); assert.equal(calls, 1);
});
function clientFixture({ failCommand = false } = {}) {
  const calls = []; let saved;
  const client = new LoungeClient({ screenId: 'test-screen', loungeToken: 'old-token', remoteId: 'test-remote' }, {
    savePairing: value => { saved = value; },
    fetcher: async (url, opts) => {
      calls.push({ url, form: new URLSearchParams(opts.body) });
      if (url.includes('get_lounge_token_batch')) return response(JSON.stringify({ screens: [{ screenId: 'test-screen', loungeToken: 'fresh-token' }] }));
      if (new URLSearchParams(opts.body).has('req0__sc')) { if (failCommand) throw new Error('ambiguous network timeout'); return response(''); }
      return response(framed([[0, ['c', 'sid-test']], [1, ['S', 'gsid-test']]]));
    }
  });
  return { client, calls, saved: () => saved };
}
test('Lounge refreshes token, single-flights concurrent connection, sequences offsets', async () => {
  const { client, calls, saved } = clientFixture(); await Promise.all([client.connect(), client.connect(), client.connect()]);
  assert.equal(calls.length, 2); assert.equal(saved().loungeToken, 'fresh-token');
  const result = await client.command('setPlaylist', { videoId: 'dQw4w9WgXcQ' }); await client.command('pause');
  assert.equal(result.confirmed, false); assert.equal(calls[2].form.get('ofs'), '1'); assert.equal(calls[3].form.get('ofs'), '2');
  assert.equal(new URL(calls[2].url).searchParams.get('loungeIdToken'), 'fresh-token');
});
test('Lounge command with uncertain network failure is not automatically replayed', async () => {
  const { client, calls } = clientFixture({ failCommand: true }); await assert.rejects(client.command('setPlaylist', { videoId: 'dQw4w9WgXcQ' }), { code: 'LOUNGE_NETWORK' });
  assert.equal(calls.filter(x => x.form.has('req0__sc')).length, 1);
  assert.equal(client.sid, null);
});
test('Lounge AID replay is ignored', () => {
  const seen = []; const client = new LoungeClient({}, { onEvent: x => seen.push(x.id) });
  client.consume({ id: 5, name: 'noop', args: [] }); client.consume({ id: 5, name: 'noop', args: [] }); client.consume({ id: 3, name: 'noop', args: [] }); assert.deepEqual(seen, [5]);
});
function adapterFixture(t) {
  const calls = [], events = [];
  const client = { aid: 10, epoch: 1, connect: async () => {}, command: async (name, params) => { calls.push({ name, params }); return { confirmed: false }; }, poll: async signal => new Promise((resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) };
  const adapter = new LoungeAdapter({ experimental: true }, { client }); adapter.setListener(e => events.push(e)); t.after(() => adapter.close());
  const send = (id, name, payload) => adapter.handle({ id, name, args: [payload] });
  return { adapter, calls, events, send };
}
const track = { sessionId: 'session-a', videoId: 'dQw4w9WgXcQ' };
test('native TV playback confirms only requested video + nonce + playing state', async t => {
  const { adapter, events, send } = adapterFixture(t); await adapter.play(track); assert.equal(events.length, 0);
  send(11, 'nowPlaying', { videoId: 'aaaaaaaaaaa', cpn: 'wrong', state: 1 }); assert.equal(events.length, 0);
  send(12, 'nowPlaying', { videoId: track.videoId, state: 1 }); assert.equal(events.length, 0);
  send(13, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn-one', state: 1 }); assert.equal(events[0].event, 'playing');
  assert.equal(events[0].sessionId, 'session-a');
});
test('native ended without playing or without matching nonce never advances', async t => {
  const { adapter, events, send } = adapterFixture(t); await adapter.play(track);
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn', state: 0 }); assert.equal(events.length, 0);
  send(12, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn', state: 1 });
  send(13, 'onStateChange', { cpn: 'different', state: 0 }); send(14, 'onStateChange', { state: 0 }); assert.equal(events.length, 1);
  send(15, 'onStateChange', { cpn: 'cpn', state: 0 }); send(16, 'onStateChange', { cpn: 'cpn', state: 0 }); assert.deepEqual(events.map(x => x.event), ['playing', 'ended']);
});
test('same video requested twice requires a NEW playback nonce', async t => {
  const { adapter, events, send } = adapterFixture(t); await adapter.play(track);
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'old-cpn', state: 1 });
  await adapter.play({ ...track, sessionId: 'session-b' });
  send(12, 'nowPlaying', { videoId: track.videoId, cpn: 'old-cpn', state: 1 }); send(13, 'onStateChange', { cpn: 'old-cpn', state: 0 }); assert.equal(events.length, 1);
  send(14, 'nowPlaying', { videoId: track.videoId, cpn: 'new-cpn', state: 1 }); assert.equal(events[1].sessionId, 'session-b');
});
test('native stop pauses app and detaches current generation; disconnect reports uncertainty', async t => {
  const { adapter, events, send, calls } = adapterFixture(t); await adapter.play(track);
  send(11, 'loungeScreenDisconnected', {}); assert.equal(events[0].event, 'offline');
  await adapter.stop(); send(12, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn', state: 1 }); assert.equal(events.length, 1); assert.equal(calls.at(-1).name, 'pause');
});
test('complete engine + native adapter: confirmed end advances exactly once', async t => {
  const { adapter, send } = adapterFixture(t);
  const engine = new Engine({ store: new MemoryStore(), youtube: { resolve: async () => ({ videoId: track.videoId, title: 'Test song' }) }, adapter });
  await engine.command({ text: '추가 test' }); await engine.command({ text: '추가 test' });
  const first = engine.state.current.sessionId;
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'first-cpn', state: 1 }); await engine.chain; assert.equal(engine.state.current.status, 'playing');
  send(12, 'onStateChange', { cpn: 'first-cpn', state: 0 }); await engine.chain;
  assert.notEqual(engine.state.current.sessionId, first); assert.equal(engine.state.history.length, 1);
  send(13, 'onStateChange', { cpn: 'first-cpn', state: 0 }); await engine.chain; assert.equal(engine.state.history.length, 1);
});
test('Lounge remains opt-in; no full computer or local network discovery is required', () => {
  assert.throws(() => new LoungeAdapter({}), { code: 'LOUNGE_OPT_IN' });
});
test('manual change on TV reports external control instead of silently hijacking playback', async t => {
  const { adapter, send, events } = adapterFixture(t); await adapter.play(track);
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn', state: 1 });
  send(12, 'nowPlaying', { videoId: 'aaaaaaaaaaa', cpn: 'external-cpn', state: 1 }); assert.equal(events.at(-1).event, 'external');
});
test('old streaming connection cannot corrupt AID of a freshly reconnected session', async () => {
  let deliver;
  const client = new LoungeClient({ screenId: 'test-screen' }, { fetcher: async () => new Promise(resolve => { deliver = resolve; }) });
  client.sid = 'old-sid'; client.gsession = 'old-gsid'; client.epoch = 1; client.aid = 4;
  const polling = client.poll(new AbortController().signal); await new Promise(resolve => setImmediate(resolve));
  client.epoch = 2; client.aid = 1; client.sid = 'new-sid';
  deliver(response(framed([[100, ['nowPlaying', { state: 0, cpn: 'old' }]]]))); await polling;
  assert.equal(client.aid, 1); assert.equal(client.sid, 'new-sid');
});
test('cancelled long poll preserves session while an actual network failure invalidates it', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  const client = new LoungeClient({}, { fetcher: async () => { throw new Error('network'); } });
  client.sid = 'sid'; client.gsession = 'gsid';
  await assert.rejects(client.poll(controller.signal)); assert.equal(client.sid, 'sid');
  await assert.rejects(client.poll(new AbortController().signal)); assert.equal(client.sid, null);
});
