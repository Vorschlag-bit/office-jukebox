import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { validLocalHostname, privatePeer, isLoopback } from './security.js';
import { check } from './util.js';

// An app-owned advertisement, not an installed OS service or a network scan.
export function startBonjour({ hostname, port, interfaceName }, { platform = process.platform, interfaces = networkInterfaces, launch = spawn, interval = setInterval, clear = clearInterval, log = console.warn } = {}) {
  check(platform === 'darwin' && validLocalHostname(hostname) && Number.isInteger(port) && port > 0 && port <= 65535 && typeof interfaceName === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(interfaceName), 'BONJOUR_CONFIG', 'Bonjour 별칭에는 macOS, 올바른 .local 이름·포트·네트워크 인터페이스가 필요합니다.');
  const health = { enabled: true, status: 'waiting' };
  let child = null, address = null, stopped = false, updating = false;
  const stopChild = async () => {
    const previous = child; child = null;
    if (!previous) return;
    await new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer); resolve(); };
      previous.once('exit', done); timer = setTimeout(done, 750);
      previous.kill('SIGTERM');
    });
  };
  const refresh = async () => {
    if (stopped || updating) return;
    updating = true;
    try {
      const next = (interfaces()[interfaceName] || []).find(x => x.family === 'IPv4' && !x.internal && privatePeer(x.address) && !isLoopback(x.address))?.address || null;
      if (child && next === address) return;
      await stopChild(); address = next;
      if (stopped || !next) { health.status = stopped ? 'stopped' : 'waiting'; return; }
      health.status = 'registering';
      const registration = launch('/usr/bin/dns-sd', ['-P', 'Office Jukebox', '_http._tcp', 'local', String(port), hostname.toLowerCase(), next, 'path=/queue'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child = registration;
      const output = chunk => {
        if (child !== registration || stopped) return;
        const text = String(chunk);
        if (/NameConflict|Name Conflict|error|failed/i.test(text)) { health.status = 'error'; log('BONJOUR_REGISTER: 이름 등록을 확인하세요. 기존 주소로 서버는 계속 사용할 수 있습니다.'); }
        else if (/Add|Registered|REGISTER/i.test(text)) health.status = 'advertised';
      };
      registration.stdout?.on('data', output); registration.stderr?.on('data', output);
      registration.once('error', () => { if (child === registration) { child = null; health.status = 'error'; log('BONJOUR_START: 로컬 이름 등록 도구를 실행하지 못했습니다.'); } });
      registration.once('exit', () => { if (child === registration) { child = null; health.status = stopped ? 'stopped' : 'error'; } });
    } catch { health.status = 'error'; log('BONJOUR_REGISTER: 로컬 이름 등록을 확인하세요.'); }
    finally { updating = false; }
  };
  const timer = interval(() => { void refresh(); }, 10000); timer.unref?.();
  void refresh();
  return { health, stop() { stopped = true; clear(timer); health.status = 'stopped'; void stopChild(); } };
}
