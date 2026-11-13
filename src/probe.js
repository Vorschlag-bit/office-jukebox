import net from 'node:net';
import tls from 'node:tls';
import { check } from './util.js';

export async function probe(config, fingerprintOnly = false) {
  check(['samsung', 'lg'].includes(config.type), 'PROBE', 'probe/fingerprint는 삼성 또는 LG 어댑터의 명시된 기기 주소 하나만 검사합니다.');
  const url = new URL(config.url);
  check(['ws:', 'wss:'].includes(url.protocol), 'PROBE', 'ws/wss 주소가 필요합니다.');
  if (fingerprintOnly) check(url.protocol === 'wss:', 'PROBE', '인증서를 읽으려면 wss 주소를 설정하세요.');
  const result = await new Promise((resolve, reject) => {
    // Inspection only: no application data or credentials are sent on this socket.
    const socket = fingerprintOnly ? tls.connect({ host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false }) : net.connect({ host: url.hostname, port: Number(url.port || (url.protocol === 'wss:' ? 443 : 80)) });
    socket.setTimeout(5000, () => socket.destroy(new Error('TCP 연결 시간 초과')));
    socket.once('error', reject);
    socket.once(fingerprintOnly ? 'secureConnect' : 'connect', () => {
      const answer = fingerprintOnly ? { fingerprint256: socket.getPeerCertificate().fingerprint256, verified: false, warning: '기기 인증서와 별도로 대조한 뒤 설정하세요.' } : { reachable: true, playbackVerified: false };
      socket.destroy(); resolve(answer);
    });
  });
  return result;
}
