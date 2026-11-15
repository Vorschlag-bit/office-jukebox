import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { MemoryStore, Store } from '../src/store.js';
import { BrowserAdapter } from '../src/adapters.js';
import { AppError } from '../src/util.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = 'https://youtu.be/dQw4w9WgXcQ';
function setup(options = {}) {
  let at = 100000;
  const store = options.store || new MemoryStore();
  const engine = new Engine({ store, youtube: { resolve: async q => ({ videoId: 'dQw4w9WgXcQ', title: q }) }, adapter: new BrowserAdapter(), now: () => at, ...options });
  return { engine, store, tick: n => { at += n; } };
}
const add = (engine, extra = {}) => engine.command({ text: `추가 ${URL}`, ...extra });
test('offline browser preserves queue without claiming playback', async () => {
  const { engine } = setup(); await add(engine);
  assert.equal(engine.state.current, null); assert.equal(engine.state.queue.length, 1); assert.equal(engine.snapshot().player.online, false);
});
test('browser heartbeat dispatches; playing event is the only confirmation', async () => {
  const { engine } = setup(); await add(engine);
  await engine.heartbeat('client-1234'); assert.equal(engine.state.current.status, 'sent_unconfirmed');
  await engine.playerEvent({ clientId: 'client-1234', sessionId: engine.state.current.sessionId, event: 'playing' });
  assert.equal(engine.state.current.status, 'playing');
});
test('ended advances queue and stale ended event cannot skip new song', async () => {
  const { engine } = setup(); await engine.heartbeat('client-1234'); await add(engine); await add(engine);
  const sessionId = engine.state.current.sessionId;
  await engine.playerEvent({ clientId: 'client-1234', sessionId, event: 'playing' });
  await engine.playerEvent({ clientId: 'client-1234', sessionId, event: 'ended' });
  assert.notEqual(engine.state.current.sessionId, sessionId); assert.equal(engine.state.queue.length, 0);
  await assert.rejects(engine.playerEvent({ clientId: 'client-1234', sessionId, event: 'ended' }), { code: 'STALE' });
  assert.equal(engine.state.history.length, 1);
});
test('blocked autoplay is visible and never treated as success', async () => {
  const { engine } = setup(); await engine.heartbeat('client-1234'); await add(engine);
  await engine.playerEvent({ clientId: 'client-1234', sessionId: engine.state.current.sessionId, event: 'blocked' });
  assert.equal(engine.state.current.status, 'blocked');
});
test('unembeddable video error does not silently skip queued songs', async () => {
  const { engine } = setup(); await engine.heartbeat('client-1234'); await add(engine); await add(engine);
  await engine.playerEvent({ clientId: 'client-1234', sessionId: engine.state.current.sessionId, event: 'error' });
  assert.equal(engine.state.current.status, 'error'); assert.equal(engine.state.queue.length, 1);
});
test('concurrent duplicate Google messages enqueue exactly once and one reply', async () => {
  const { engine } = setup();
  await Promise.all(Array.from({ length: 20 }, () => add(engine, { eventId: 'spaces/a/messages/m', space: 'spaces/a' })));
  assert.equal(engine.state.queue.length, 1); assert.equal(engine.state.outbox.length, 1);
});
test('concurrent different requests preserve FIFO', async () => {
  const { engine } = setup(); await Promise.all(Array.from({ length: 15 }, (_, i) => engine.command({ text: `추가 song${i}` })));
  assert.deepEqual(engine.state.queue.map(x => x.title), Array.from({ length: 15 }, (_, i) => `song${i}`));
});
test('queue capacity protects search quota', async () => {
  const { engine } = setup({ maxQueue: 1 }); await add(engine);
  await assert.rejects(add(engine), { code: 'QUEUE_FULL' });
});
test('expired requests do not play on reconnect', async () => {
  const { engine, tick } = setup({ queueTtlMs: 1000 }); await add(engine); tick(1001); await engine.heartbeat('client-1234');
  assert.equal(engine.state.current, null); assert.equal(engine.state.history[0].status, 'expired');
});
test('second browser cannot steal active lease', async () => {
  const { engine } = setup(); await engine.heartbeat('client-1234');
  await assert.rejects(engine.heartbeat('client-5678'), { code: 'LEASE' });
});
test('replacement browser requires operator recovery instead of replay', async () => {
  const { engine, tick } = setup(); await engine.heartbeat('client-1234'); await add(engine); tick(15001); await engine.heartbeat('client-5678');
  assert.equal(engine.state.current.status, 'recovery_required');
  await assert.rejects(engine.playerEvent({ clientId: 'client-5678', sessionId: engine.state.current.sessionId, event: 'playing' }), { code: 'RECOVERY' });
});
test('same browser after long outage also requires recovery', async () => {
  const { engine, tick } = setup(); await engine.heartbeat('client-1234'); await add(engine); tick(15001); await engine.heartbeat('client-1234');
  assert.equal(engine.state.current.status, 'recovery_required');
});
test('native command acceptance does not claim playing or auto-advance', async () => {
  const adapter = { type: 'native', info: () => ({}), play: async () => ({ confirmed: false }), stop: async () => {} };
  const { engine, tick } = setup({ adapter }); await add(engine); await add(engine); tick(3600000);
  assert.equal(engine.state.current.status, 'sent_unconfirmed'); assert.equal(engine.state.queue.length, 1);
  await engine.command({ text: '확인', operator: true }); assert.equal(engine.state.current.confirmation, 'operator');
});
test('device timeout leaves uncertain current and preserves pending queue', async () => {
  const adapter = { type: 'native', info: () => ({}), play: async () => { throw new AppError('DEVICE_TIMEOUT', 'timeout', 504); }, stop: async () => {} };
  const { engine } = setup({ adapter }); await add(engine); await add(engine);
  assert.equal(engine.state.current.status, 'error'); assert.equal(engine.state.current.error, 'DEVICE_TIMEOUT'); assert.equal(engine.state.queue.length, 1);
});
for (const command of ['다음', '정지', '재시도', '확인']) test(`operator-only: ${command}`, async () => {
  const { engine } = setup(); await assert.rejects(engine.command({ text: command }), { code: 'FORBIDDEN' });
});
test('failed stop preserves current state and queue', async () => {
  const adapter = { type: 'native', info: () => ({}), play: async () => ({ confirmed: false }), stop: async () => { throw new AppError('DEVICE_TIMEOUT', 'timeout', 504); } };
  const { engine } = setup({ adapter }); await add(engine); await add(engine);
  await assert.rejects(engine.command({ text: '정지', operator: true }), { code: 'DEVICE_TIMEOUT' });
  assert.ok(engine.state.current); assert.equal(engine.state.queue.length, 1);
});
test('stop clears queue, retry issues a fresh session', async () => {
  const { engine } = setup(); await engine.heartbeat('client-1234'); await add(engine);
  const old = engine.state.current.sessionId; engine.state.current.status = 'error';
  await engine.command({ text: '재시도', operator: true }); assert.notEqual(engine.state.current.sessionId, old);
  await add(engine); await engine.command({ text: '정지', operator: true }); assert.equal(engine.state.current, null); assert.equal(engine.state.queue.length, 0);
});
test('restart restores queue and dedup but requires current recovery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jukebox-')); t.after(() => rmSync(dir, { recursive: true }));
  const { engine } = setup({ store: new Store(dir) }); await engine.heartbeat('client-1234'); await add(engine, { eventId: 'event-1' }); await add(engine);
  const restored = setup({ store: new Store(dir) }).engine;
  assert.equal(restored.state.current.status, 'recovery_required'); assert.equal(restored.state.queue.length, 1);
  await add(restored, { eventId: 'event-1' }); assert.equal(restored.state.queue.length, 1);
});
test('corrupt disk state fails without overwriting', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jukebox-')); t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'state.json'), '{bad'); assert.throws(() => new Store(dir));
});

test('playlist import respects per-user and total limits, preserves order and deduplicates delivery', async () => {
  let calls=0;const songs=Array.from({length:10},(_,i)=>({videoId:'dQw4w9WgXcQ',title:`song ${i+1}`}));
  const {engine}=setup({maxQueue:4,perUserLimit:3,youtube:{playlist:async()=>{calls++;return songs}}});
  engine.state.queue.push({id:'existing',title:'someone else',requestedBy:'other',expiresAt:999999});
  const command={text:'목록 https://youtube.com/playlist?list=PL1234567890abc 2',user:'listener',eventId:'playlist-event',space:'spaces/test'};
  const reply=await engine.command(command);assert.match(reply,/3곡/);assert.match(reply,/ 5/);
  assert.deepEqual(engine.state.queue.map(x=>x.title),['someone else','song 2','song 3','song 4']);
  assert.ok(engine.state.queue.slice(1).every(x=>x.requestedBy==='listener'&&x.requestSpace==='spaces/test'));
  await engine.command(command);assert.equal(calls,1);assert.equal(engine.state.queue.length,4);
  await assert.rejects(engine.command({...command,eventId:'another'}),{code:'QUEUE_FULL'});assert.equal(calls,1);
});
test('playlist failures and bad ranges leave queue unchanged; watch links remain single songs', async () => {
  const {engine}=setup({youtube:{playlist:async()=>{throw new AppError('PLAYLIST_EMPTY','empty')},resolve:async()=>({videoId:'dQw4w9WgXcQ',title:'single'})}});
  await assert.rejects(engine.command({text:'playlist https://youtube.com/playlist?list=PL1234567890abc'}),{code:'PLAYLIST_EMPTY'});assert.equal(engine.state.queue.length,0);
  await assert.rejects(engine.command({text:'목록 https://youtube.com/playlist?list=PL1234567890abc 101'}),{code:'PLAYLIST_START'});
  await engine.command({text:'추가 https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890abc'});assert.equal(engine.state.queue.length,1);
});
test('playlist supports direct add links, starts offline then advances through actual ended events', async () => {
  const songs=[{videoId:'dQw4w9WgXcQ',title:'one'},{videoId:'s7gef3SXSbY',title:'two'}];
  const {engine}=setup({youtube:{playlist:async()=>songs}});
  await engine.command({text:'추가 https://youtube.com/playlist?list=PL1234567890abc'});assert.equal(engine.state.current,null);assert.equal(engine.state.queue.length,2);
  await engine.heartbeat('client-1234');assert.equal(engine.state.current.title,'one');
  const sessionId=engine.state.current.sessionId;
  await engine.playerEvent({clientId:'client-1234',sessionId,event:'playing'});
  await engine.playerEvent({clientId:'client-1234',sessionId,event:'ended'});assert.equal(engine.state.current.title,'two');
});

test('large playlists cap each import at twenty and user quota rejects before network access', async () => {
  let calls=0;const {engine}=setup({youtube:{playlist:async()=>{calls++;return Array.from({length:100},(_,i)=>({videoId:'dQw4w9WgXcQ',title:`song ${i}`}));}}});
  const reply=await engine.command({text:'목록 https://youtube.com/playlist?list=PL1234567890abc',user:'test'});
  assert.equal(engine.state.queue.length,20);assert.match(reply,/ 21/);assert.ok(reply.length<1500);
  engine.perUserLimit=5;
  await assert.rejects(engine.command({text:'목록 https://youtube.com/playlist?list=PL1234567890abc',user:'test'}),{code:'USER_LIMIT'});assert.equal(calls,1);
});
