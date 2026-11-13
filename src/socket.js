// Small bounded RFC 6455 client. TV TLS exceptions are scoped to one pinned certificate.
import http from 'node:http';
import https from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { AppError, check } from './util.js';

export function encodeFrame(data, { masked = true, opcode = 1 } = {}) {
  const payload = Buffer.from(data);
  const extra = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (masked ? 0x80 : 0) | (extra === 0 ? payload.length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(payload.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  const body = Buffer.from(payload);
  if (masked) {
    const mask = randomBytes(4); mask.copy(header, 2 + extra);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  }
  return Buffer.concat([header, body]);
}
export class FrameDecoder {
  constructor(onFrame, max = 1048576) { this.buffer = Buffer.alloc(0); this.onFrame = onFrame; this.max = max; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b = this.buffer, masked = !!(b[1] & 128);
      check(!(b[0] & 0x70), 'WS_PROTOCOL', '압축 WebSocket 프레임은 지원하지 않습니다.');
      let len = b[1] & 127, offset = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); offset = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        check(big <= BigInt(this.max), 'WS_SIZE', '기기 응답 크기 초과');
        len = Number(big); offset = 10;
      }
      check(len <= this.max, 'WS_SIZE', '기기 응답 크기 초과');
      if ((b[0] & 15) >= 8) check((b[0] & 128) && len <= 125, 'WS_PROTOCOL', '잘못된 제어 프레임');
      const start = offset + (masked ? 4 : 0);
      if (b.length < start + len) return;
      const payload = Buffer.from(b.subarray(start, start + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[offset + i % 4];
      const frame = { opcode: b[0] & 15, final: !!(b[0] & 128), masked, payload };
      this.buffer = b.subarray(start + len);
      this.onFrame(frame);
    }
  }
}
export class JsonSocket {
  constructor(url, { fingerprint, timeout = 10000 } = {}) {
    this.url = new URL(url); this.fingerprint = fingerprint; this.timeout = timeout;
    this.pending = new Set(); this.backlog = []; this.fragments = []; this.fragmentBytes = 0;
  }
  async connect() {
    const u = this.url;
    check(['ws:', 'wss:'].includes(u.protocol), 'WS_URL', 'ws 또는 wss 주소가 필요합니다.');
    if (u.protocol === 'wss:') check(/^[a-fA-F0-9:]{64,95}$/.test(this.fingerprint || ''), 'TLS_PIN', 'TV의 SHA-256 인증서 지문을 먼저 설정하세요.');
    const key = randomBytes(16).toString('base64');
    await new Promise((resolve, reject) => {
      const transport = u.protocol === 'wss:' ? https : http;
      const request = transport.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', rejectUnauthorized: u.protocol !== 'wss:', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
      const timer = setTimeout(() => request.destroy(new Error('연결 시간 초과')), this.timeout);
      request.on('error', error => { clearTimeout(timer); reject(new AppError('DEVICE_CONNECT', error.message, 502)); });
      request.on('response', response => { response.resume(); request.destroy(); clearTimeout(timer); reject(new AppError('WS_UPGRADE', `기기가 WebSocket 연결을 거부했습니다: ${response.statusCode}`, 502)); });
      request.on('upgrade', (response, socket, head) => {
        clearTimeout(timer);
        try {
          if (u.protocol === 'wss:') {
            const actual = socket.getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase();
            check(actual === this.fingerprint.replaceAll(':', '').toLowerCase(), 'TLS_PIN', 'TV 인증서 지문이 일치하지 않습니다.');
          }
          const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          check(response.headers['sec-websocket-accept'] === expected, 'WS_HANDSHAKE', 'WebSocket 핸드셰이크 불일치');
          this.socket = socket;
          const decoder = new FrameDecoder(frame => {
            check(!frame.masked, 'WS_PROTOCOL', '서버가 마스킹한 프레임을 전송했습니다.');
            if (frame.opcode === 8) { this.close(); return; }
            if (frame.opcode === 9) { socket.write(encodeFrame(frame.payload, { opcode: 10 })); return; }
            if (frame.opcode === 10) return;
            check([0, 1].includes(frame.opcode), 'WS_PROTOCOL', '지원하지 않는 프레임');
            check(frame.opcode === 0 ? this.fragments.length > 0 : this.fragments.length === 0, 'WS_PROTOCOL', '잘못된 분할 프레임');
            this.fragmentBytes += frame.payload.length;
            check(this.fragmentBytes <= 1048576, 'WS_SIZE', '기기 응답 크기 초과');
            this.fragments.push(frame.payload);
            if (!frame.final) return;
            const value = JSON.parse(Buffer.concat(this.fragments).toString('utf8'));
            this.fragments = []; this.fragmentBytes = 0;
            const waiter = [...this.pending].find(x => x.matches(value));
            if (waiter) waiter.resolve(value);
            else { this.backlog.push(value); if (this.backlog.length > 50) this.backlog.shift(); }
          });
          socket.on('data', data => { try { decoder.push(data); } catch (e) { this.close(e); } });
          socket.on('error', e => this.close(e));
          socket.on('close', () => this.close(new AppError('DEVICE_CLOSED', '기기 연결이 종료되었습니다.', 502)));
          if (head.length) decoder.push(head);
          resolve();
        } catch (e) { socket.destroy(); reject(e); }
      });
      request.end();
    });
    return this;
  }
  async send(value) {
    check(this.socket && !this.socket.destroyed, 'DEVICE_CLOSED', '기기 연결이 없습니다.', 502);
    await new Promise((resolve, reject) => this.socket.write(encodeFrame(JSON.stringify(value)), e => e ? reject(e) : resolve()));
  }
  wait(matches, timeout = this.timeout) {
    const i = this.backlog.findIndex(matches);
    if (i !== -1) return Promise.resolve(this.backlog.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const done = (fn, value) => { clearTimeout(timer); this.pending.delete(item); fn(value); };
      const item = { matches, resolve: x => done(resolve, x), reject: e => done(reject, e) };
      const timer = setTimeout(() => item.reject(new AppError('DEVICE_TIMEOUT', '기기 응답 시간 초과', 504)), timeout);
      this.pending.add(item);
    });
  }
  close(error = new AppError('DEVICE_CLOSED', '기기 연결 종료', 502)) {
    const socket = this.socket; this.socket = null;
    socket?.destroy();
    for (const waiter of [...this.pending]) waiter.reject(error);
  }
}
