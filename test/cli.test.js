import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/main.js';
import { probe } from '../src/probe.js';

const entry = fileURLToPath(new URL('../src/main.js', import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jukebox-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configFile = join(directory, 'config.local.json');
  const env = { ...process.env, JUKEBOX_CONFIG: configFile };
  const run = (...args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 10000 });
  return { configFile, env, run };
}
test('CLI init generates unique tokens, never overwrites existing config or prints tokens', t => {
  const { configFile, run } = fixture(t);
  const result = run('init'); assert.equal(result.status, 0);
  const config = loadConfig(configFile);
  assert.equal(config.adminToken.length, 43); assert.notEqual(config.adminToken, config.playerToken);
  assert.ok(!result.stdout.includes(config.adminToken)); assert.equal(config.host, '127.0.0.1'); assert.equal(config.google.enabled, false);
  assert.equal(run('init').status, 1); assert.equal(loadConfig(configFile).adminToken, config.adminToken);
});
test('CLI doctor reports configuration, no hardware success or secrets', t => {
  const { configFile, run } = fixture(t); run('init'); const config = loadConfig(configFile);
  const result = run('doctor'); assert.equal(result.status, 0); assert.match(result.stdout, /"hardwareVerified": false/); assert.ok(!result.stdout.includes(config.playerToken));
});
test('configuration rejects weak or reused tokens', t => {
  const { configFile, run } = fixture(t); run('init'); const config = loadConfig(configFile);
  config.playerToken = config.adminToken; writeFileSync(configFile, JSON.stringify(config)); assert.throws(() => loadConfig(configFile), { code: 'CONFIG' });
});
test('configuration requires nonempty Chat space allowlist when enabled', t => {
  const { configFile, run } = fixture(t); run('init'); const config = loadConfig(configFile);
  config.google.enabled = true; config.google.allowedSpaces = []; writeFileSync(configFile, JSON.stringify(config)); assert.throws(() => loadConfig(configFile), { code: 'CONFIG' });
});
test('probe only accepts supported explicit TV targets; fingerprint requires TLS', async () => {
  await assert.rejects(probe({ type: 'browser' }), { code: 'PROBE' });
  await assert.rejects(probe({ type: 'lg', url: 'ws://192.0.2.10:3000' }, true), { code: 'PROBE' });
});
test('actual CLI server starts with generated config and serves authenticated queue', async t => {
  const { configFile, env, run } = fixture(t); assert.equal(run('init').status, 0);
  const config = JSON.parse(readFileSync(configFile, 'utf8')); config.port = 0; writeFileSync(configFile, JSON.stringify(config));
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const base = await new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(new Error('CLI startup timeout')), 5000);
    child.stdout.on('data', data => { output += data; const found = output.match(/Office Jukebox: (http:\/\/127\.0\.0\.1:\d+)/); if (found) { clearTimeout(timeout); resolve(found[1]); } });
    child.on('error', reject); child.on('exit', code => { if (code !== 0) { clearTimeout(timeout); reject(new Error(`CLI exited: ${code}`)); } });
  });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const response = await fetch(`${base}/api/command`, { method: 'POST', headers: { Authorization: `Bearer ${config.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '추가 https://youtu.be/dQw4w9WgXcQ' }) });
  assert.equal(response.status, 200);
  const state = await (await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${config.adminToken}` } })).json();
  assert.equal(state.queue.length, 1); assert.equal(state.current, null);
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
});
