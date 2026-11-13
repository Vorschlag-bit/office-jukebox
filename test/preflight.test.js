import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogle } from '../src/preflight.js';
test('Google preflight uses only GET, never posts messages or consumes a subscription', async () => {
  const calls = [], scopes = [];
  const result = await verifyGoogle({ subscription: 'projects/test/subscriptions/jukebox', allowedSpaces: ['spaces/test'] }, { token: async scope => { scopes.push(scope); return 'FAKE_TOKEN'; } }, async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({}) }; });
  assert.equal(result.ok, true); assert.equal(result.messagePosted, false); assert.equal(result.playbackVerified, false);
  assert.equal(calls.length, 2); assert.ok(calls.every(x => !x.opts.method || x.opts.method === 'GET'));
  assert.ok(calls.every(x => !x.url.includes(':pull') && !x.url.endsWith('/messages'))); assert.equal(scopes[1], 'https://www.googleapis.com/auth/chat.bot');
  assert.ok(!JSON.stringify(result).includes('FAKE_TOKEN'));
});
test('preflight reports authorization failures per service while keeping tokens out of report', async () => {
  const result = await verifyGoogle({ subscription: 'projects/test/subscriptions/jukebox', allowedSpaces: ['spaces/test'] }, { token: async () => 'SECRET' }, async url => ({ ok: !url.includes('chat.googleapis.com'), status: 403, json: async () => ({}) }));
  assert.equal(result.ok, false); assert.equal(result.checks[0].ok, true); assert.equal(result.checks[1].upstreamStatus, 403); assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('preflight rejects arbitrary URLs before fetching', async () => {
  await assert.rejects(verifyGoogle({ subscription: 'https://evil.test', allowedSpaces: [] }, {}, () => { throw new Error('must not fetch'); }), { code: 'CONFIG' });
});
