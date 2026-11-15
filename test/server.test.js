import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';
import { YouTube } from '../src/youtube.js';
import { BrowserAdapter } from '../src/adapters.js';

async function start(t) {
  const config = { adminToken: 'a'.repeat(40), playerToken: 'p'.repeat(40) };
  const engine = new Engine({ store: new MemoryStore(), youtube: new YouTube(), adapter: new BrowserAdapter() });
  const server = createServer({ engine, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (path, body, role = 'admin', extraHeaders = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${role === 'admin' ? config.adminToken : role === 'player' ? config.playerToken : role}`, 'Content-Type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { api, base, engine };
}
test('HTTP end-to-end: queue → player poll → playing → ended', async t => {
  const { api } = await start(t);
  assert.equal((await api('/api/command', { text: '추가 https://youtu.be/dQw4w9WgXcQ' })).status, 200);
  const poll = await (await api('/api/player/poll', { clientId: 'client-1234' }, 'player')).json();
  assert.equal(poll.current.status, 'sent_unconfirmed');
  const event = { clientId: 'client-1234', sessionId: poll.current.sessionId, event: 'playing' };
  assert.equal((await api('/api/player/event', event, 'player')).status, 200);
  assert.equal((await (await api('/api/state')).json()).current.status, 'playing');
  await api('/api/player/event', { ...event, event: 'ended' }, 'player');
  assert.equal((await (await api('/api/state')).json()).current, null);
});
test('tokens are role-separated; player cannot submit admin commands', async t => {
  const { api } = await start(t);
  assert.equal((await api('/api/state', undefined, 'bad')).status, 401);
  assert.equal((await api('/api/command', { text: '정지' }, 'player')).status, 401);
  assert.equal((await api('/api/player/poll', { clientId: 'client-1234' })).status, 401);
});
test('embedded playback credentials are admin-issued, player-only, and absent from URLs', async t => {
  const {api,base}=await start(t);
  assert.equal((await api('/api/playback-session',{},'player')).status,401);
  assert.equal((await api('/api/playback-session',{},'admin',{Origin:'https://evil.example'})).status,403);
  const r=await api('/api/playback-session',{});assert.equal(r.status,200);
  const {token}=await r.json();assert.ok(token.length>=32);assert.notEqual(token,'p'.repeat(40));
  assert.equal((await api('/api/player/poll',{clientId:'embedded-client'},token)).status,200);
  assert.equal((await api('/api/command',{text:'정지'},token)).status,401);
  assert.equal((await api('/api/capabilities',undefined,token)).status,401);
  assert.equal((await (await api('/api/capabilities')).json()).searchEnabled,false);
  assert.match((await fetch(base+'/player')).headers.get('Content-Security-Policy'),/frame-ancestors 'self'/);
  assert.match((await fetch(base+'/')).headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
});
test('cross-origin writes rejected, no CORS credentials exposed', async t => {
  const { api } = await start(t);
  const r = await api('/api/command', { text: '대기열' }, 'admin', { Origin: 'https://evil.example' });
  assert.equal(r.status, 403); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});
test('oversize command, unknown path, wrong method fail safely', async t => {
  const { api } = await start(t);
  assert.equal((await api('/api/command', { text: 'x'.repeat(9000) })).status, 413);
  assert.equal((await api('/api/command', { text: 'x'.repeat(501) })).status, 400);
  assert.equal((await api('/api/missing', {})).status, 404);
  assert.equal((await api('/api/command')).status, 405);
});
test('malformed JSON and wrong content type are rejected', async t => {
  const { base } = await start(t);
  const headers = { Authorization: `Bearer ${'a'.repeat(40)}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/command', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/command', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});
test('only allowlisted assets served; config and traversal inaccessible', async t => {
  const { base } = await start(t);
  for (const path of ['/config.local.json', '/data/state.json', '/../src/main.js', '/src/main.js']) assert.equal((await fetch(base + path)).status, 404);
  const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(r.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(await r.text(), /Office Jukebox/); assert.equal(r.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  const wallpaper = await fetch(base + '/usagi-wallpaper.jpg'); assert.equal(wallpaper.status, 200); assert.equal(wallpaper.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await wallpaper.arrayBuffer()).slice(0, 3)], [255, 216, 255]);
});
test('JSON null and arrays cannot crash API handlers', async t => {
  const { base } = await start(t);
  for (const body of ['null', '[]', '"string"']) {
    const r = await fetch(base + '/api/command', { method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(40)}`, 'Content-Type': 'application/json' }, body }); assert.equal(r.status, 400);
  }
});
test('Hangul JSON split inside multibyte UTF-8 characters remains intact', async t => {
  const { base } = await start(t); const body = Buffer.from(JSON.stringify({ text: '대기열' }));
  const result = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/command', { method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(40)}`, 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', x => { data += x; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.write(body.subarray(0, 10)); setImmediate(() => { req.write(body.subarray(10, 11)); setImmediate(() => req.end(body.subarray(11))); });
  });
  assert.equal(result.status, 200); assert.match(result.body.text, /현재:/);
});
test('diagnostics disclose counts only; dead-letter replay is admin-only and preserves IDs', async t => {
  const { api, engine } = await start(t);
  engine.state.deadLetters.push({ id: 'test-reply-id', space: 'spaces/test', text: 'reply', failure: 'CHAT_HTTP_403', failedAt: 1 });
  assert.equal((await api('/api/diagnostics', undefined, 'player')).status, 401);
  const diagnostic = await (await api('/api/diagnostics')).json(); assert.equal(diagnostic.notifications.failed, 1); assert.equal(diagnostic.adminToken, undefined);
  assert.equal((await api('/api/retry-notifications', {}, 'player')).status, 401);
  assert.equal((await (await api('/api/retry-notifications', {})).json()).requeued, 1); assert.equal(engine.state.outbox[0].id, 'test-reply-id');
});
