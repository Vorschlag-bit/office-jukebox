import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { FrameDecoder, encodeFrame, JsonSocket } from '../src/socket.js';

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
