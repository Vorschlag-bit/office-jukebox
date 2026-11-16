import { check } from './util.js';
export const normalizedAddress = address => String(address || '').replace(/^::ffff:/, '');
export function isLoopback(address) { const a=normalizedAddress(address); return a==='::1'||/^127\./.test(a); }
export function privatePeer(address) { const a=normalizedAddress(address);return isLoopback(a)||/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a); }
export function validHost(req) {
  try {
    const url=new URL('http://'+req.headers.host),local=normalizedAddress(req.socket.localAddress),name=url.hostname.replace(/^\[|\]$/g,'');
    return !url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash&&Number(url.port||(req.socket.encrypted?443:80))===req.socket.localPort&&(name===local||(isLoopback(req.socket.remoteAddress)&&isLoopback(local)&&['localhost','127.0.0.1','::1'].includes(name)));
  } catch { return false; }
}
export function secureControlTransport(req) { return req.socket.encrypted===true||isLoopback(req.socket.remoteAddress); }

export function assertRuntimeVersion(version = process.versions.node) {
  const [major, minor, patch] = version.split('.').map(Number);
  check((major === 24 && (minor > 22 || minor === 22 && patch >= 3)) || (major === 26 && (minor > 13 || minor === 13 && patch >= 1)), 'NODE_SECURITY', 'Node 24.22.3 이상(24 LTS) 또는 26.13.1 이상(26 LTS)의 보안 패치가 필요합니다. 프로젝트의 LAN 서버 시작 파일을 사용하세요.');
}
