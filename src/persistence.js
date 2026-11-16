import { openSync, writeSync, fsyncSync, closeSync, renameSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, AppError } from './util.js';

export function atomicJson(path, data, { backup = false } = {}) {
  const text = JSON.stringify(data, null, 2);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    const bytes = Buffer.from(text); let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    if (backup && existsSync(path)) {
      // Atomic replacement also repairs a legacy backup with broad permissions.
      const previous = readFileSync(path, 'utf8');
      const backupTemp = `${temp}.bak`;
      let backupFd;
      try {
        backupFd = openSync(backupTemp, 'wx', 0o600);
        const bytes = Buffer.from(previous); let offset = 0;
        while (offset < bytes.length) offset += writeSync(backupFd, bytes, offset);
        fsyncSync(backupFd); closeSync(backupFd); backupFd = undefined;
        renameSync(backupTemp, `${path}.bak`);
      } finally { if (backupFd !== undefined) closeSync(backupFd); if (existsSync(backupTemp)) rmSync(backupTemp); }
    }
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) rmSync(temp);
  }
}
export function acquireLock(directory) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'server.lock');
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, nonce })); fsyncSync(fd); } finally { closeSync(fd); }
      return () => {
        try { if (JSON.parse(readFileSync(file, 'utf8')).nonce === nonce) rmSync(file); } catch { /* Never remove another process's lock. */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new AppError('LOCK', '잠금 파일이 손상됐습니다. 실행 중인 서버를 확인한 뒤 잠금 파일을 별도 보관하세요.'); }
      check(Number.isInteger(owner.pid) && owner.pid > 0, 'LOCK', '잘못된 서버 잠금 파일');
      try { process.kill(owner.pid, 0); throw new AppError('ALREADY_RUNNING', '같은 저장소를 사용하는 서버가 이미 실행 중입니다.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      // Re-read before removing a stale lock. A competing process may have acquired it.
      check(JSON.parse(readFileSync(file, 'utf8')).nonce === owner.nonce, 'LOCK', '서버 잠금이 변경됐습니다. 다시 시작하세요.');
      rmSync(file);
    }
  }
  throw new AppError('LOCK', '서버 잠금을 얻지 못했습니다.');
}
