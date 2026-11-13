import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { ServiceAccountAuth, GoogleWorker, normalizeChatEvent } from '../src/google.js';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';
import { BrowserAdapter } from '../src/adapters.js';

const now = Date.parse('2026-11-13T12:00:00Z');
const legacy = () => ({ type: 'MESSAGE', eventTime: new Date(now).toISOString(), space: { name: 'spaces/test' }, message: { name: 'spaces/test/messages/one', argumentText: '추가 https://youtu.be/dQw4w9WgXcQ', text: '@뮤직봇 추가 https://youtu.be/dQw4w9WgXcQ', sender: { name: 'users/alice', type: 'HUMAN' }, thread: { name: 'spaces/test/threads/t' } } });
function setup(fetcher = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
  const engine = new Engine({ store: new MemoryStore(), youtube: { resolve: async () => ({ videoId: 'dQw4w9WgXcQ', title: 'song' }) }, adapter: new BrowserAdapter(), now: () => now });
  const worker = new GoogleWorker({ config: { subscription: 'projects/demo/subscriptions/jukebox', allowedSpaces: ['spaces/test'], operatorUsers: ['users/admin'] }, auth: { token: async () => 'access-token' }, engine, fetcher, now: () => now });
  return { worker, engine };
}
const message = event => ({ ackId: 'ack', message: { messageId: 'msg1', publishTime: new Date(now).toISOString(), data: Buffer.from(JSON.stringify(event)).toString('base64') } });
test('legacy interaction event normalizes argumentText and sender', () => {
  const result = normalizeChatEvent(legacy()); assert.equal(result.user, 'users/alice'); assert.ok(result.text.startsWith('추가')); assert.equal(result.space, 'spaces/test');
});
test('Workspace add-on chat.messagePayload event also normalizes', () => {
  const old = legacy(); const result = normalizeChatEvent({ chat: { messagePayload: { space: old.space, message: old.message } } }); assert.equal(result.space, 'spaces/test'); assert.equal(result.name, old.message.name);
});
test('bot mention removed by annotation offsets without dropping song text', () => {
  const event = legacy(); delete event.message.argumentText;
  event.message.annotations = [{ type: 'USER_MENTION', startIndex: 0, length: 4, userMention: { user: { type: 'BOT' } } }];
  assert.ok(normalizeChatEvent(event).text.startsWith('추가'));
});
test('bot messages and removal events are ignored', () => {
  const e = legacy(); e.message.sender.type = 'BOT'; assert.equal(normalizeChatEvent(e), null); assert.equal(normalizeChatEvent({ type: 'REMOVED_FROM_SPACE' }), null);
});
test('allowlisted fresh message enters queue; redelivery is idempotent', async () => {
  const { worker, engine } = setup(); await worker.receive(message(legacy())); await worker.receive(message(legacy()));
  assert.equal(engine.state.queue.length, 1); assert.equal(engine.state.outbox.length, 1);
});
test('other spaces cannot control playback', async () => {
  const { worker, engine } = setup(); const e = legacy(); e.space.name = 'spaces/other'; await worker.receive(message(e)); assert.equal(engine.state.queue.length, 0);
});
for (const age of [300001, -60001]) test(`stale or future commands ignored: ${age}ms`, async () => {
  const { worker, engine } = setup(); const e = legacy(); e.eventTime = new Date(now - age).toISOString(); await worker.receive(message(e)); assert.equal(engine.state.queue.length, 0);
});
test('missing event time falls back to Pub/Sub publish time', async () => {
  const { worker, engine } = setup(); const e = legacy(); delete e.eventTime; await worker.receive(message(e)); assert.equal(engine.state.queue.length, 1);
});
test('regular users cannot skip; denial is persisted once', async () => {
  const { worker, engine } = setup(); const e = legacy(); e.message.argumentText = '다음'; await worker.receive(message(e)); await worker.receive(message(e));
  assert.equal(engine.state.outbox.length, 1); assert.match(engine.state.outbox[0].text, /운영자/);
});
test('operator identity is the Google user ID, not display name or message text', async () => {
  const { worker, engine } = setup(); const e = legacy(); e.message.argumentText = '정지'; e.message.sender.name = 'users/admin'; await worker.receive(message(e));
  assert.match(engine.state.outbox[0].text, /정지 명령/);
});
test('poison messages are ignored safely', async () => {
  const { worker, engine } = setup(); await worker.receive({ message: { data: Buffer.from('{').toString('base64') } }); assert.equal(engine.state.outbox.length, 0);
});
test('outbox uses deterministic client message ID and handles already-created reply', async () => {
  const calls = []; const { worker, engine } = setup(async (url, opts) => { calls.push({ url, opts }); return { ok: false, status: 409 }; });
  await worker.receive(message(legacy())); const id = engine.state.outbox[0].id; await worker.flush();
  assert.equal(new URL(calls[0].url).searchParams.get('messageId'), `client-${id}`); assert.equal(engine.state.outbox.length, 0);
});
test('failed Chat response remains in outbox for retry without duplicate song', async () => {
  const { worker, engine } = setup(async () => ({ ok: false, status: 503 })); await worker.receive(message(legacy()));
  await assert.rejects(worker.flush(), { code: 'CHAT_SEND' }); assert.equal(engine.state.outbox.length, 1);
  await worker.receive(message(legacy())); assert.equal(engine.state.queue.length, 1);
});
test('Pub/Sub cycle extends deadline and ACKs only after durable handling', async () => {
  const calls = [];
  const { worker, engine } = setup(async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith(':acknowledge')) assert.equal(engine.state.queue.length, 1);
    return { ok: true, status: 200, json: async () => String(url).endsWith(':pull') ? { receivedMessages: [message(legacy())] } : {} };
  });
  await worker.cycle(); assert.ok(calls[1].endsWith(':modifyAckDeadline')); assert.ok(calls[2].endsWith(':acknowledge')); assert.match(calls[3], /chat.googleapis.com/);
});
test('service-account JWT is correctly signed, scopes separated and tokens cached', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let calls = 0, clock = now;
  const auth = new ServiceAccountAuth({ type: 'service_account', client_email: 'test@example.iam.gserviceaccount.com', private_key: privateKey }, { now: () => clock, fetcher: async (url, opts) => {
    calls++; assert.equal(url, 'https://oauth2.googleapis.com/token');
    const parts = new URLSearchParams(opts.body).get('assertion').split('.');
    const verify = createVerify('RSA-SHA256'); verify.update(parts.slice(0, 2).join('.')); assert.ok(verify.verify(publicKey, parts[2], 'base64url'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url')); assert.equal(payload.exp - payload.iat, 3600);
    return { ok: true, json: async () => ({ access_token: `token${calls}`, expires_in: 3600 }) };
  } });
  assert.equal(await auth.token('scope-a'), 'token1'); assert.equal(await auth.token('scope-a'), 'token1'); assert.equal(await auth.token('scope-b'), 'token2');
  clock += 3600000; assert.equal(await auth.token('scope-a'), 'token3');
});
