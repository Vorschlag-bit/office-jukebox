import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { FrameDecoder, encodeFrame, JsonSocket, normalizeFingerprint } from '../src/socket.js';

for (const size of [0, 4, 125, 126, 65535, 65536]) test(`WebSocket frame roundtrip size ${size}, arbitrary TCP splits`, () => {
  const text = 'x'.repeat(size), frames = [];
  const decoder = new FrameDecoder(frame => frames.push(frame));
  const frame = encodeFrame(text);
  for (let i = 0; i < frame.length; i += 13) decoder.push(frame.subarray(i, i + 13));
  assert.equal(frames.length, 1); assert.equal(frames[0].payload.toString(), text); assert.equal(frames[0].masked, true);
});
test('WebSocket oversized declared frames rejected before buffering payload', () => {
  const b = Buffer.alloc(10); b[0] = 129; b[1] = 127; b.writeBigUInt64BE(10000000n, 2);
  assert.throws(() => new FrameDecoder(() => {}).push(b), { code: 'WS_SIZE' });
});
test('WebSocket invalid fragmented control frame rejected', () => {
  assert.throws(() => new FrameDecoder(() => {}).push(Buffer.from([9, 0])), { code: 'WS_PROTOCOL' });
});
test('TLS TV connection requires explicit certificate pin before any request', async () => {
  await assert.rejects(new JsonSocket('wss://192.0.2.1:8002').connect(), { code: 'TLS_PIN' });
});
test('SHA-256 pins accept exact hex or colon format and reject ambiguous shapes', () => {
  assert.equal(normalizeFingerprint('AA:'.repeat(31) + 'AA'), 'aa'.repeat(32));
  for (const pin of ['aa'.repeat(31), ':'.repeat(64), 'aa:'.repeat(32), 'gg'.repeat(32)]) assert.throws(() => normalizeFingerprint(pin), { code: 'TLS_PIN' });
});
function ephemeralCertificate() {
  // Generate a self-signed test certificate in memory. No embedded or downloaded private key.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  function der(tag, value) {
    const b = Buffer.from(value); let n = b.length, len;
    if (n < 128) len = Buffer.from([n]);
    else { const bytes = []; while (n) { bytes.unshift(n & 255); n >>>= 8; } len = Buffer.from([128 | bytes.length, ...bytes]); }
    return Buffer.concat([Buffer.from([tag]), len, b]);
  }
  const seq = (...parts) => der(48, Buffer.concat(parts));
  const algorithm = seq(Buffer.from('06092a864886f70d01010b0500', 'hex'));
  const name = seq(der(49, seq(Buffer.from('0603550403', 'hex'), der(12, Buffer.from('localhost')))));
  const validity = seq(der(23, Buffer.from('250101000000Z')), der(23, Buffer.from('350101000000Z')));
  const tbs = seq(der(160, der(2, [2])), der(2, [1]), algorithm, name, validity, name, pair.publicKey.export({ format: 'der', type: 'spki' }));
  const bytes = seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('RSA-SHA256', tbs, pair.privateKey)])));
  const pem = label => `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----`;
  return { key: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), cert: pem('CERTIFICATE'), fingerprint: createHash('sha256').update(bytes).digest('hex') };
}
test('real TLS pin mismatch sends ZERO HTTP requests/tokens; matching certificate upgrades', async t => {
  const certificate = ephemeralCertificate(); let requests = 0; const sockets = new Set();
  const server = https.createServer({ key: certificate.key, cert: certificate.cert });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => {});
  server.on('upgrade', (req, socket) => {
    requests++;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  const url = `wss://127.0.0.1:${server.address().port}/?token=TEST_ONLY`;
  await assert.rejects(new JsonSocket(url, { fingerprint: '00'.repeat(32) }).connect(), { code: 'TLS_PIN' }); assert.equal(requests, 0);
  const client = new JsonSocket(url, { fingerprint: certificate.fingerprint }); await client.connect(); assert.equal(requests, 1); client.close();
});
async function mockTv(t, onMessage, { badHandshake = false } = {}) {
  const server = http.createServer(); const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${badHandshake ? 'wrong' : key}\r\n\r\n`);
    const decoder = new FrameDecoder(frame => { if (frame.opcode === 1) onMessage(JSON.parse(frame.payload), socket); });
    socket.on('data', chunk => decoder.push(chunk));
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(resolve); }));
  return `ws://127.0.0.1:${server.address().port}`;
}
test('actual TCP/WebSocket exchange works with a fake TV (no hardware claim)', async t => {
  const url = await mockTv(t, (message, socket) => socket.write(encodeFrame(JSON.stringify({ id: message.id, payload: { returnValue: true } }), { masked: false })));
  const ws = new JsonSocket(url); await ws.connect();
  await ws.send({ id: 'launch', command: 'test' });
  assert.equal((await ws.wait(x => x.id === 'launch')).payload.returnValue, true); ws.close();
});
test('invalid WebSocket upgrade response rejected', async t => {
  const url = await mockTv(t, () => {}, { badHandshake: true });
  await assert.rejects(new JsonSocket(url).connect(), { code: 'WS_HANDSHAKE' });
});
test('device response timeout and closure reject pending requests', async t => {
  const url = await mockTv(t, () => {}); const ws = new JsonSocket(url, { timeout: 30 }); await ws.connect();
  await assert.rejects(ws.wait(() => true), { code: 'DEVICE_TIMEOUT' });
  const waiting = ws.wait(() => true); ws.close(); await assert.rejects(waiting, { code: 'DEVICE_CLOSED' });
});
test('fragmented JSON and ping frames handled across real socket', async t => {
  const url = await mockTv(t, (message, socket) => {
    const a = encodeFrame('{"id":', { masked: false }); a[0] = 1;
    socket.write(a); socket.write(encodeFrame('ping', { masked: false, opcode: 9 })); socket.write(encodeFrame('"ok"}', { masked: false, opcode: 0 }));
  });
  const ws = new JsonSocket(url); await ws.connect(); await ws.send({ test: true });
  assert.equal((await ws.wait(x => x.id === 'ok')).id, 'ok'); ws.close();
});
