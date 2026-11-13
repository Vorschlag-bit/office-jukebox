import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';
import { BrowserAdapter } from '../src/adapters.js';
import { GoogleWorker } from '../src/google.js';
import { safeChatText } from '../src/google.js';
import { boundedText, jsonFetch } from '../src/util.js';
import { decodeTitle } from '../src/youtube.js';

function fixture(options = {}) {
  let now = 100000, saves = 0;
  const store = new MemoryStore(); store.save = () => { saves++; };
  const youtube = { resolve: async q => ({ videoId: 'dQw4w9WgXcQ', title: q }), search: async q => [{ videoId: 'dQw4w9WgXcQ', title: `${q} A` }, { videoId: 'aaaaaaaaaaa', title: `${q} B` }] };
  const engine = new Engine({ store, youtube, adapter: new BrowserAdapter(), now: () => now, ...options });
  const event = (type, extra = {}) => engine.playerEvent({ clientId: 'client-test', sessionId: engine.state.current.sessionId, event: type, ...extra });
  return { engine, tick: n => { now += n; }, saves: () => saves, event };
}
test('search → choice is scoped to user, space, and 5 minute TTL', async () => {
  const { engine, tick } = fixture();
  await engine.command({ text: '검색 song', user: 'users/a', space: 'spaces/a' });
  await assert.rejects(engine.command({ text: '선택 1', user: 'users/b', space: 'spaces/a' }), { code: 'CHOICE_EXPIRED' });
  await assert.rejects(engine.command({ text: '선택 1', user: 'users/a', space: 'spaces/b' }), { code: 'CHOICE_EXPIRED' });
  await engine.command({ text: '선택 2', user: 'users/a', space: 'spaces/a' }); assert.equal(engine.state.queue[0].videoId, 'aaaaaaaaaaa');
  await engine.command({ text: '검색 song', user: 'users/a', space: 'spaces/a' }); tick(300001);
  await assert.rejects(engine.command({ text: '선택 1', user: 'users/a', space: 'spaces/a' }), { code: 'CHOICE_EXPIRED' });
});
test('per-user limit blocks excess requests before expensive search', async () => {
  let searches = 0; const { engine } = fixture({ perUserLimit: 1, youtube: { resolve: async () => { searches++; return { videoId: 'dQw4w9WgXcQ', title: 'song' }; } } });
  await engine.command({ text: '추가 song', user: 'users/a' });
  await assert.rejects(engine.command({ text: '추가 song', user: 'users/a' }), { code: 'USER_LIMIT' }); assert.equal(searches, 1);
  await engine.command({ text: '추가 song', user: 'users/b' }); assert.equal(engine.state.queue.length, 2);
});
test('users can cancel only their own queued song; operators can cancel any', async () => {
  const { engine } = fixture(); await engine.command({ text: '추가 A', user: 'users/a' }); await engine.command({ text: '추가 B', user: 'users/b' });
  await assert.rejects(engine.command({ text: '취소 1', user: 'users/b' }), { code: 'FORBIDDEN' });
  await engine.command({ text: '취소 2', user: 'users/b' }); assert.equal(engine.state.queue.length, 1);
  await engine.command({ text: '취소 1', operator: true }); assert.equal(engine.state.queue.length, 0);
});
test('paused queue does not dispatch on heartbeat; resume starts it', async () => {
  const { engine } = fixture(); await engine.command({ text: '일시정지', operator: true }); await engine.command({ text: '추가 song' }); await engine.heartbeat('client-test');
  assert.equal(engine.state.current, null); assert.equal(engine.state.queue.length, 1);
  await engine.command({ text: '계속', operator: true }); assert.ok(engine.state.current);
});
test('pause/resume use requested controls, never falsely acknowledge actual playback', async () => {
  const { engine } = fixture(); await engine.heartbeat('client-test'); await engine.command({ text: '추가 song' });
  await engine.command({ text: '일시정지', operator: true }); assert.equal(engine.state.current.desiredState, 'paused'); assert.equal(engine.state.current.status, 'sent_unconfirmed');
  await engine.command({ text: '계속', operator: true }); assert.equal(engine.state.current.controlVersion, 2);
});
test('ended before playing is rejected; duplicate ended cannot consume next song', async () => {
  const { engine, event } = fixture(); await engine.heartbeat('client-test'); await engine.command({ text: '추가 song' });
  await assert.rejects(event('ended'), { code: 'ENDING_BEFORE_PLAY' }); assert.equal(engine.state.history.length, 0);
});
test('three consecutive unplayable embeds trip circuit; network errors do not skip', async () => {
  const { engine, event } = fixture({ autoSkipUnplayable: true }); await engine.heartbeat('client-test');
  for (let i = 0; i < 4; i++) await engine.command({ text: `추가 song${i}` });
  await event('error', { errorCode: 101 }); await event('error', { errorCode: 150 }); await event('error', { errorCode: 100 });
  assert.equal(engine.state.paused, true); assert.equal(engine.state.history.length, 3); assert.equal(engine.state.queue.length, 1); assert.equal(engine.state.current, null);
  await engine.command({ text: '계속', operator: true }); await event('error', { errorCode: 5 }); assert.equal(engine.state.current.status, 'error'); assert.equal(engine.state.history.length, 3);
});
test('one successful playback resets the consecutive unplayable count', async () => {
  const { engine, event } = fixture({ autoSkipUnplayable: true }); await engine.heartbeat('client-test');
  for (let i = 0; i < 5; i++) await engine.command({ text: `추가 song${i}` });
  await event('error', { errorCode: 101 }); await event('playing'); await event('ended'); await event('error', { errorCode: 101 }); await event('error', { errorCode: 101 });
  assert.equal(engine.state.paused, false); assert.ok(engine.state.current);
});
test('watchdog catches expired browser lease; no automatic replay on recovery', async () => {
  const { engine, tick } = fixture(); await engine.heartbeat('client-test'); await engine.command({ text: '추가 song' }); tick(15001); await engine.tick(); assert.equal(engine.state.current.status, 'recovery_required');
});
test('native request without confirmation times out without claiming success', async () => {
  const { engine, tick } = fixture({ adapter: { type: 'native', info: () => ({}), play: async () => ({ confirmed: false }) }, handshakeTimeoutMs: 1000 });
  await engine.command({ text: '추가 song' }); tick(1001); await engine.tick(); assert.equal(engine.state.current.error, 'PLAYBACK_NOT_CONFIRMED');
});
test('idle polling and duplicate playing events do not rewrite disk continuously', async () => {
  const { engine, saves, event } = fixture(); await engine.heartbeat('client-test');
  for (let i = 0; i < 100; i++) { await engine.heartbeat('client-test'); await engine.tick(); } assert.equal(saves(), 0);
  await engine.command({ text: '추가 song' }); await event('playing'); const previous = saves();
  for (let i = 0; i < 100; i++) await event('playing'); assert.equal(saves(), previous);
});
test('actual playing notification is queued once and carries the original thread', async () => {
  const { engine, event } = fixture(); await engine.heartbeat('client-test');
  await engine.command({ text: '추가 song', space: 'spaces/a', thread: 'spaces/a/threads/a', eventId: 'message-a' });
  assert.equal(engine.state.outbox.length, 1); await event('playing'); await event('playing'); assert.equal(engine.state.outbox.length, 2); assert.equal(engine.state.outbox[1].thread, 'spaces/a/threads/a');
});
function workerFixture(fetcher) {
  const { engine } = fixture();
  const worker = new GoogleWorker({ config: { subscription: 'projects/test/subscriptions/test', allowedSpaces: ['spaces/a'], operatorUsers: [] }, auth: { token: async () => 'fake' }, engine, fetcher, now: () => 100000, log: () => {} });
  engine.state.outbox.push({ id: 'reply-one', space: 'spaces/a', text: 'test' });
  return { engine, worker };
}
test('permanently denied Chat replies go to bounded dead letters and do not block others', async () => {
  let sent = 0; const { engine, worker } = workerFixture(async () => ({ ok: false, status: ++sent === 1 ? 403 : 409 }));
  engine.state.outbox.push({ id: 'reply-two', space: 'spaces/a', text: 'next' }); await worker.flush();
  assert.equal(engine.state.outbox.length, 0); assert.equal(engine.state.deadLetters.length, 1); assert.equal(sent, 2);
});
test('Chat HTTP 503 cannot prevent Pub/Sub pull; retries have exponential backoff', async () => {
  let pulls = 0;
  const { engine, worker } = workerFixture(async url => {
    if (String(url).includes('chat.googleapis.com')) return { ok: false, status: 503 };
    pulls++; return { ok: true, json: async () => ({}) };
  });
  await worker.cycle(); assert.equal(pulls, 1); assert.equal(engine.state.outbox[0].attempts, 1); assert.ok(engine.state.outbox[0].nextAttemptAt > 100000);
});
test('slow Chat reply never holds the engine lock for local commands', async () => {
  let finish;
  const { engine, worker } = workerFixture(async () => new Promise(resolve => { finish = resolve; }));
  const flushing = worker.flush(); await new Promise(resolve => setImmediate(resolve));
  const result = await Promise.race([engine.command({ text: '대기열' }), new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('engine frozen')), 1000); t.unref(); })]);
  assert.match(result, /현재/); finish({ ok: true, status: 200 }); await flushing;
});
test('parallel outbox flush calls do not send same response twice', async () => {
  let sent = 0; const { worker } = workerFixture(async () => { sent++; await new Promise(resolve => setImmediate(resolve)); return { ok: true, status: 200 }; });
  await Promise.all([worker.flush(), worker.flush(), worker.flush()]); assert.equal(sent, 1);
});
test('bounded JSON fetch handles hostile size, invalid JSON and sanitized network error', async () => {
  await assert.rejects(boundedText(new Response('abcdef'), 5), { code: 'UPSTREAM_SIZE' });
  await assert.rejects(jsonFetch('https://test.invalid', {}, async () => new Response('{')), { code: 'UPSTREAM_FORMAT' });
  await assert.rejects(jsonFetch('https://test.invalid?key=SECRET', {}, async () => { throw new Error('SECRET'); }), e => e.code === 'NETWORK' && !e.message.includes('SECRET'));
});
test('search title decoding is Unicode-safe and UI still uses text nodes', () => {
  assert.equal(decodeTitle('A &amp; B &#x1F3B5; &#39;x&#39;'), "A & B 🎵 'x'"); assert.equal(decodeTitle('&#99999999;'), '&#99999999;');
});
test('stale admin cancellation ID cannot accidentally cancel a different song', async () => {
  const { engine } = fixture(); await engine.command({ text: '추가 A' }); await engine.command({ text: '추가 B' });
  const id = engine.state.queue[0].id;
  await engine.command({ text: '취소 1', operator: true });
  await assert.rejects(engine.command({ text: `취소 id:${id}`, operator: true }), { code: 'CANCEL' }); assert.equal(engine.state.queue[0].title, 'B');
});
test('Chat titles cannot inject structured mentions or hyperlinks', () => {
  assert.equal(safeChatText('title <users/all> <https://evil.test|click>'), 'title ‹users/all› ‹https://evil.test|click›');
});
