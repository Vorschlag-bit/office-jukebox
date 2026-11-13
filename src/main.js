import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { YouTube } from './youtube.js';
import { Engine } from './engine.js';
import { createAdapter } from './adapters.js';
import { createServer } from './server.js';
import { ServiceAccountAuth, GoogleWorker } from './google.js';
import { check } from './util.js';
import { probe } from './probe.js';

export function loadConfig(path) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  check(typeof c.adminToken === 'string' && c.adminToken.length >= 32 && !c.adminToken.includes('REPLACE'), 'CONFIG', 'init 명령으로 관리자 토큰을 생성하세요.');
  check(typeof c.playerToken === 'string' && c.playerToken.length >= 32 && c.playerToken !== c.adminToken && !c.playerToken.includes('RANDOM'), 'CONFIG', '서로 다른 32자 이상의 재생기 토큰이 필요합니다.');
  check(Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535, 'CONFIG', '잘못된 포트 번호');
  check(typeof c.host === 'string' && c.adapter?.type, 'CONFIG', 'host와 adapter.type이 필요합니다.');
  check(Number.isInteger(c.maxQueue) && c.maxQueue > 0 && c.maxQueue <= 500 && Number.isInteger(c.queueTtlMs) && c.queueTtlMs >= 60000, 'CONFIG', '대기열 한도와 만료 시간을 확인하세요.');
  if (c.google?.enabled) check(c.google.allowedSpaces?.length && Array.isArray(c.google.operatorUsers), 'CONFIG', 'Google Chat 허용 채팅방과 운영자를 지정하세요.');
  return c;
}
async function main() {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configFile = resolve(process.env.JUKEBOX_CONFIG || `${base}/config.local.json`);
  if (process.argv[2] === 'init') {
    check(!existsSync(configFile), 'EXISTS', 'config.local.json이 이미 있습니다. 덮어쓰지 않았습니다.');
    const c = JSON.parse(readFileSync(`${base}/config.example.json`, 'utf8'));
    c.adminToken = randomBytes(32).toString('base64url'); c.playerToken = randomBytes(32).toString('base64url');
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 });
    console.log('config.local.json을 생성했습니다. 토큰은 이 파일에서 확인하세요.'); return;
  }
  check(existsSync(configFile), 'CONFIG', '먼저 node src/main.js init 을 실행하세요.');
  const config = loadConfig(configFile);
  if (['probe', 'fingerprint'].includes(process.argv[2])) {
    console.log(JSON.stringify(await probe(config.adapter, process.argv[2] === 'fingerprint'), null, 2)); return;
  }
  const savePairing = patch => {
    Object.assign(config.adapter, patch);
    writeFileSync(`${configFile}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
    // writeFileSync above + atomic replacement avoids corrupting credentials on interruption.
    renameSync(`${configFile}.tmp`, configFile);
  };
  const adapter = createAdapter(config.adapter, { savePairing });
  if (process.argv[2] === 'doctor') {
    console.log(JSON.stringify({ node: process.version, adapter: adapter.info(), googleEnabled: !!config.google?.enabled, bind: `${config.host}:${config.port}`, hardwareVerified: false }, null, 2));
    console.log('이 진단은 설정 검사입니다. TV 연결·재생 성공을 의미하지 않습니다.'); return;
  }
  const store = new Store(resolve(dirname(configFile), config.dataDir || 'data'));
  const engine = new Engine({ store, youtube: new YouTube(config.youtubeApiKey), adapter, maxQueue: config.maxQueue, queueTtlMs: config.queueTtlMs });
  const server = createServer({ engine, config });
  let worker;
  if (config.google?.enabled) {
    const credentials = JSON.parse(readFileSync(resolve(dirname(configFile), config.google.serviceAccountFile), 'utf8'));
    worker = new GoogleWorker({ config: config.google, auth: new ServiceAccountAuth(credentials), engine });
  }
  server.listen(config.port, config.host, () => {
    console.log(`Office Jukebox: http://${config.host}:${server.address().port}`);
    console.log('관리 화면 / · 재생 화면 /player · 토큰은 config.local.json에서 확인');
    if (worker) void worker.start();
  });
  const shutdown = () => { worker?.stop(); server.close(); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(`${e.code || 'STARTUP'}: ${e.message}`); process.exitCode = 1; });
