import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, acquireLock } from '../src/persistence.js';
import { Store } from '../src/store.js';

function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'jukebox-store-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('atomic JSON preserves previous valid state as backup and leaves no temp files', t => {
  const dir = directory(t), path = join(dir, 'state.json');
  atomicJson(path, { revision: 1 }, { backup: true }); atomicJson(path, { revision: 2 }, { backup: true });
  assert.equal(JSON.parse(readFileSync(path)).revision, 2); assert.equal(JSON.parse(readFileSync(`${path}.bak`)).revision, 1);
  assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'state.json.bak']);
});
test('failed serialization never damages current file', t => {
  const dir = directory(t), path = join(dir, 'state.json'); atomicJson(path, { valid: true });
  const circular = {}; circular.self = circular; assert.throws(() => atomicJson(path, circular)); assert.equal(JSON.parse(readFileSync(path)).valid, true);
});
test('second server lock is rejected, release permits next server', t => {
  const dir = directory(t), release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), { code: 'ALREADY_RUNNING' }); release();
  const next = acquireLock(dir); next(); assert.equal(existsSync(join(dir, 'server.lock')), false);
});
test('lock release never removes a replacement owner lock', t => {
  const dir = directory(t), release = acquireLock(dir);
  writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: process.pid, nonce: 'another-owner' })); release(); assert.equal(existsSync(join(dir, 'server.lock')), true);
});
test('corrupt lock is preserved and requires explicit operator attention', t => {
  const dir = directory(t); writeFileSync(join(dir, 'server.lock'), '{');
  assert.throws(() => acquireLock(dir), { code: 'LOCK' }); assert.equal(readFileSync(join(dir, 'server.lock'), 'utf8'), '{');
});
test('legacy state is migrated with safe defaults and persisted without replay', t => {
  const dir = directory(t); writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, queue: [], current: null, history: [], seen: {}, outbox: [] }));
  const store = new Store(dir); assert.deepEqual(store.state.deadLetters, []); assert.equal(store.state.paused, false); store.save(); assert.ok(existsSync(join(dir, 'state.json.bak')));
});
