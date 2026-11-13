// Optional unprivileged supervisor. No services, scheduled tasks, or system settings are installed.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
let child, timer, stopping = false;
const failures = [];
function start() {
  child = spawn(process.execPath, [main], { stdio: 'inherit', env: process.env });
  child.once('error', () => { console.error('서버 프로세스를 시작하지 못했습니다.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    if (stopping) return;
    if (code === 0) return;
    const now = Date.now(); failures.push(now);
    while (failures.length && now - failures[0] > 600000) failures.shift();
    if (failures.length >= 5) { console.error('10분 이내 5회 종료되어 자동 재시작을 중단했습니다. 설정과 로그를 확인하세요.'); process.exitCode = 1; return; }
    const wait = Math.min(30000, 1000 * 2 ** failures.length);
    console.warn(`서버 종료 (${signal || code}). ${wait / 1000}초 후 복구합니다. 현재 곡은 자동 재생하지 않습니다.`);
    timer = setTimeout(start, wait);
  });
}
function stop() { if (stopping) return; stopping = true; clearTimeout(timer); child?.kill('SIGTERM'); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
start();
