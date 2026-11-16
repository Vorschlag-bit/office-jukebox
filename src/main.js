import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store, validateState } from './store.js';
import { YouTube } from './youtube.js';
import { Engine } from './engine.js';
import { createAdapter } from './adapters.js';
import { createServer } from './server.js';
import { AppsScriptWorker, validateBridge } from './apps-script.js';
import { check, AppError } from './util.js';
import { probe } from './probe.js';
import { acquireLock, atomicJson } from './persistence.js';
import { pairTvCode } from './lounge.js';
import { createInterface } from 'node:readline/promises';


export function loadConfig(path) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  check(typeof c.adminToken === 'string' && c.adminToken.length >= 32 && !c.adminToken.includes('REPLACE'), 'CONFIG', 'init 명령으로 관리자 토큰을 생성하세요.');
  check(typeof c.playerToken === 'string' && c.playerToken.length >= 32 && c.playerToken !== c.adminToken && !c.playerToken.includes('RANDOM'), 'CONFIG', '서로 다른 32자 이상의 재생기 토큰이 필요합니다.');
  check(Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535, 'CONFIG', '잘못된 포트 번호');
  check(typeof c.host === 'string' && c.adapter?.type, 'CONFIG', 'host와 adapter.type이 필요합니다.');
  check(c.lan === undefined || (c.lan && typeof c.lan.enabled === 'boolean'), 'CONFIG', 'lan.enabled는 true 또는 false여야 합니다.');
  check(Number.isInteger(c.maxQueue) && c.maxQueue > 0 && c.maxQueue <= 500 && Number.isInteger(c.queueTtlMs) && c.queueTtlMs >= 60000, 'CONFIG', '대기열 한도와 만료 시간을 확인하세요.');
  c.perUserLimit ??= 5; c.autoSkipUnplayable ??= true; c.handshakeTimeoutMs ??= 45000;
  check(Number.isInteger(c.perUserLimit) && c.perUserLimit >= 0 && c.perUserLimit <= 100, 'CONFIG', 'perUserLimit는 0~100 사이 정수여야 합니다.');
  check(typeof c.autoSkipUnplayable === 'boolean' && Number.isInteger(c.handshakeTimeoutMs) && c.handshakeTimeoutMs >= 15000 && c.handshakeTimeoutMs <= 300000, 'CONFIG', '재생 확인 제한과 영상 오류 처리 설정을 확인하세요.');
  if (c.google?.enabled) {
    check(Array.isArray(c.google.allowedSpaces) && c.google.allowedSpaces.length > 0 && c.google.allowedSpaces.every(x => typeof x === 'string' && /^spaces\/[A-Za-z0-9_-]+$/.test(x)), 'CONFIG', '허용 채팅방을 spaces/리소스ID 형식으로 지정하세요.');
    check(Array.isArray(c.google.operatorUsers) && c.google.operatorUsers.every(x => typeof x === 'string' && /^users\/[A-Za-z0-9_-]+$/.test(x)), 'CONFIG', '운영자는 users/리소스ID 형식으로 지정하세요. 이메일과 표시 이름은 사용할 수 없습니다.');
    validateBridge(c.google);
    check(c.google.sharedSecret !== c.adminToken && c.google.sharedSecret !== c.playerToken, 'CONFIG', 'Apps Script 공유 비밀은 관리자·재생기 토큰과 달라야 합니다.');
  }
  return c;
}
async function main() {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configFile = resolve(process.env.JUKEBOX_CONFIG || `${base}/config.local.json`);
  if (process.argv[2] === 'init') {
    check(!existsSync(configFile), 'EXISTS', 'config.local.json이 이미 있습니다. 덮어쓰지 않았습니다.');
    const c = JSON.parse(readFileSync(`${base}/config.example.json`, 'utf8'));
    c.adminToken = randomBytes(32).toString('base64url'); c.playerToken = randomBytes(32).toString('base64url');
    c.google.sharedSecret = randomBytes(32).toString('base64url');
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600, flag: 'wx' });
    console.log('config.local.json을 생성했습니다. 토큰은 이 파일에서 확인하세요.'); return;
  }
  check(existsSync(configFile), 'CONFIG', '먼저 node src/main.js init 을 실행하세요.');
  const config = loadConfig(configFile);
  const dataDirectory = resolve(dirname(configFile), config.dataDir || 'data');
  if (process.argv[2] === 'check-google') {
    check(config.google?.enabled, 'CONFIG', '먼저 Apps Script 연동 설정을 활성화하세요.');
    const worker = new AppsScriptWorker({ config: config.google });
    try { console.log(JSON.stringify(await worker.check(), null, 2)); } finally { worker.stop(); }
    return;
  }
  if (['pair-tv', 'use-browser', 'use-previous', 'restore-state'].includes(process.argv[2])) {
    const release = acquireLock(dataDirectory);
    try {
      if (process.argv[2] === 'restore-state') {
        const path = resolve(dataDirectory, 'state.json');
        check(existsSync(`${path}.bak`), 'BACKUP', '복구할 state.json.bak가 없습니다.');
        const state = validateState(JSON.parse(readFileSync(`${path}.bak`, 'utf8')));
        if (existsSync(path)) copyFileSync(path, `${path}.damaged-${Date.now()}.json`);
        atomicJson(path, state);
        console.log('백업을 복구했습니다. 기존 파일은 보존했습니다. 서버 재시작 후 현재 곡은 복구 명령을 기다립니다.');
        return;
      } else if (process.argv[2] === 'pair-tv') {
        check(process.stdin.isTTY, 'TV_CODE', '본인 TV의 유튜브 설정에서 TV 연결 코드를 확인한 뒤 터미널에서 직접 실행하세요. 코드가 로그에 남지 않도록 인수나 환경변수로 받지 않습니다.');
        const readline = createInterface({ input: process.stdin, output: process.stdout });
        let code;
        try { code = await readline.question('본인 TV 유튜브 앱의 숫자 TV 연결 코드: '); } finally { readline.close(); }
        const paired = await pairTvCode(code);
        config.previousAdapter = config.adapter; config.adapter = { type: 'lounge', experimental: true, ...paired };
      } else if (process.argv[2] === 'use-previous') {
        check(config.previousAdapter?.type, 'CONFIG', '이전 재생 방식이 없습니다.');
        const previous = config.adapter; config.adapter = config.previousAdapter; config.previousAdapter = previous;
      } else { config.previousAdapter = config.adapter; config.adapter = { type: 'browser' }; }
      atomicJson(configFile, config);
      console.log('재생 방식 설정을 저장했습니다. 서버를 시작하고 현장 재생을 검증하세요.');
    } finally { release(); }
    return;
  }
  if (['probe', 'fingerprint'].includes(process.argv[2])) {
    console.log(JSON.stringify(await probe(config.adapter, process.argv[2] === 'fingerprint'), null, 2)); return;
  }
  const savePairing = patch => {
    Object.assign(config.adapter, patch);
    atomicJson(configFile, config);
  };
  const adapter = createAdapter(config.adapter, { savePairing });
  if (process.argv[2] === 'doctor') {
    console.log(JSON.stringify({ node: process.version, adapter: adapter.info(), googleEnabled: !!config.google?.enabled, bind: `${config.host}:${config.port}`, hardwareVerified: false }, null, 2));
    console.log('이 진단은 설정 검사입니다. TV 연결·재생 성공을 의미하지 않습니다.'); return;
  }
  const release = acquireLock(dataDirectory);
  process.once('exit', release);
  const store = new Store(dataDirectory);
  const engine = new Engine({ store, youtube: new YouTube(config.youtubeApiKey, fetch, Date.now, { resolveTitles: !!config.resolveVideoTitles }), adapter, maxQueue: config.maxQueue, queueTtlMs: config.queueTtlMs, perUserLimit: config.perUserLimit, autoSkipUnplayable: config.autoSkipUnplayable, handshakeTimeoutMs: config.handshakeTimeoutMs });
  let worker;
  const server = createServer({ engine, config, diagnostics: () => ({ google: worker ? worker.health : { enabled: false }, hardwareVerified: false }) });
  if (config.google?.enabled) {
    worker = new AppsScriptWorker({ config: config.google, engine });
  }
  server.listen(config.port, config.host, () => {
    console.log(`Office Jukebox: http://${config.host}:${server.address().port}`);
    console.log('관리 화면 / · 재생 화면 /player · 토큰은 config.local.json에서 확인');
    void engine.start().catch(error => console.warn(`STARTUP_RECOVERY: ${error.code || 'TV_STATE_UNKNOWN'}. 대기열은 보존됐습니다.`));
    if (worker) void worker.start();
  });
  const watchdog = setInterval(() => { void engine.tick().catch(() => console.warn('STATE_WRITE: 저장소 상태를 확인하세요.')); }, 2000);
  watchdog.unref();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'PORT_IN_USE: 포트가 이미 사용 중입니다.' : 'SERVER_ERROR: 서버를 시작하지 못했습니다.'); adapter.close?.(); release(); process.exitCode = 1; clearInterval(watchdog); });
  const shutdown = () => { clearInterval(watchdog); worker?.stop(); adapter.close?.(); server.close(() => { release(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e instanceof AppError ? `${e.code}: ${e.message}` : 'STARTUP: 시작하지 못했습니다. 설정 파일 형식·파일 권한·저장소 상태를 확인하세요.'); process.exitCode = 1; });
