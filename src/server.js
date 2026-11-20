import http from 'node:http';
import https from 'node:https';
import { createPublicRequests, publicQueueUrl } from './public-requests.js';
import { privatePeer, validHost, secureControlTransport } from './security.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { check, equalSecret, AppError } from './util.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/player': ['player.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/voice.js': ['voice.js', 'text/javascript; charset=utf-8'], '/player.js': ['player.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/avatar.png': ['avatar.png', 'image/png'], '/usagi-wallpaper.jpg': ['usagi-wallpaper.jpg', 'image/jpeg'], '/usagi-teatime.jpg': ['usagi-teatime.jpg', 'image/jpeg'], '/usagi-cheer.jpg': ['usagi-cheer.jpg', 'image/jpeg'], '/usagi-snack.jpg': ['usagi-snack.jpg', 'image/jpeg'] };
assets['/queue'] = ['queue.html', 'text/html; charset=utf-8'];
assets['/queue.js'] = ['queue.js', 'text/javascript; charset=utf-8'];
assets['/requests.js'] = ['requests.js', 'text/javascript; charset=utf-8'];
assets['/theme.js'] = ['theme.js', 'text/javascript; charset=utf-8'];
assets['/themes.css'] = ['themes.css', 'text/css; charset=utf-8'];
assets['/stickers.js'] = ['stickers.js', 'text/javascript; charset=utf-8'];
for(const name of ['usagi','chiikawa','hachiware']) assets[`/${name}-dance.gif`] = [`${name}-dance.gif`, 'image/gif'];
for (const character of ['chiikawa', 'hachiware']) {
  assets[`/${character}-avatar.png`] = [`${character}-avatar.png`, 'image/png'];
  assets[`/${character}-wallpaper.jpg`] = [`${character}-wallpaper.jpg`, 'image/jpeg'];
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; check(size <= 8192, 'BODY_SIZE', '요청 크기가 너무 큽니다.', 413); chunks.push(chunk); }
  const data = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = JSON.parse(data || '{}'); } catch { throw new AppError('JSON', '올바른 JSON이 필요합니다.'); }
  check(body && typeof body === 'object' && !Array.isArray(body), 'JSON', 'JSON 객체가 필요합니다.');
  return body;
}
export function createServer({ engine, config, diagnostics = () => ({}), tls }) {
  const requests = createPublicRequests({engine,config});
  const buckets = new Map();
  const playbackSessions = new Map();
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', req.url?.split('?')[0] === '/player' ? 'SAMEORIGIN' : 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const embeddedPlayer = req.url?.split('?')[0] === '/player';
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; frame-src 'self' https://www.youtube.com; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://i.ytimg.com; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors " + (embeddedPlayer ? "'self'" : "'none'"));
    const send = (status, value) => { if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); } };
    try {
      // Binding to LAN never trusts forwarded headers or arbitrary DNS hosts.
      check(validHost(req, config.lan?.enabled ? config.lan.hostnames : []), 'HOST', '이 컴퓨터의 IP 또는 등록된 .local 이름과 포트로 접속해 주세요.', 403);
      if (config.lan?.enabled) {
        check(privatePeer(req.socket.remoteAddress), 'LAN_ONLY', '내부 네트워크에서만 접근할 수 있습니다.', 403);
      }
      const url = new URL(req.url, 'http://localhost');
      const ip = req.socket.remoteAddress || 'unknown';
      const bucket = buckets.get(ip) || { since: Date.now(), count: 0 };
      if (Date.now() - bucket.since > 60000) { bucket.since = Date.now(); bucket.count = 0; }
      bucket.count++; buckets.set(ip, bucket);
      check(bucket.count <= 180, 'RATE_LIMIT', '요청이 너무 많습니다.', 429);
      if (buckets.size > 1000) buckets.delete(buckets.keys().next().value);
      const publicRead = req.method === 'GET' && (['/queue','/queue.js','/health','/api/public/queue'].includes(url.pathname) || (assets[url.pathname] && !['/','/player'].includes(url.pathname)));
      const publicRequestRoute=requests.enabled() && (req.method==='GET'&&url.pathname==='/api/public/session'||req.method==='POST'&&url.pathname==='/api/public/request');
      const namedHttp = !req.socket.encrypted && new URL('http://' + req.headers.host).hostname.endsWith('.local');
      if (!publicRead && !publicRequestRoute && (!secureControlTransport(req) || namedHttp)) {
        if (req.method === 'GET' && ['/', '/player'].includes(url.pathname) && config.tls?.enabled) {
          const host = req.socket.localAddress.replace(/^::ffff:/, '');
          res.writeHead(302, { Location: `https://${host.includes(':') ? '['+host+']' : host}:${config.tls.port}${url.pathname}` }); res.end(); return;
        }
        throw new AppError('TRANSPORT', '관리자·재생기 연결은 HTTPS 또는 이 컴퓨터의 localhost에서만 사용할 수 있습니다.', 403);
      }
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, mime] = assets[url.pathname];
        const content = await readFile(`${publicDir}/${file}`); res.writeHead(200, { 'Content-Type': mime }); res.end(content); return;
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      check(url.pathname.startsWith('/api/'), 'NOT_FOUND', '없는 경로입니다.', 404);
      if (req.method==='GET' && url.pathname==='/api/public/session') return send(200,requests.session(req,res));
      if (req.method==='POST' && url.pathname==='/api/public/request') {
        check(req.headers['content-type']?.startsWith('application/json'),'CONTENT_TYPE','application/json을 사용하세요.',415);
        return send(200,await requests.request(req,await readJson(req)));
      }
      if (url.pathname === '/api/public/queue') check(config.lan?.enabled === true, 'NOT_FOUND', '공유 플리가 꺼져 있습니다.', 404);
      if (req.method === 'GET' && url.pathname === '/api/public/queue') {
        const state = engine.snapshot();
        const song = x => x ? { title: x.title, videoId: x.videoId, status: x.status, source: x.source } : null;
        return send(200, { current: song(state.current), queue: state.queue.map(song), paused: state.paused, adminTlsPort: config.tls?.enabled ? config.tls.port : null, shareUrl: publicQueueUrl(config), requestsEnabled:requests.enabled(), searchEnabled:requests.enabled()&&!!engine.youtube.key });
      }
      const player = url.pathname.startsWith('/api/player/');
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      for (const [key, until] of playbackSessions) if (until <= Date.now()) playbackSessions.delete(key);
      check(equalSecret(bearer, player ? config.playerToken : config.adminToken) || (player && playbackSessions.has(bearer)), 'AUTH', '연결 키를 확인해 주세요. 관리 화면과 재생 화면의 키는 서로 다릅니다.', 401);
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, engine.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return send(200, { searchEnabled: !!engine.youtube.key, embeddedPlayer: engine.adapter.type === 'browser', sharedQueueEnabled: config.lan?.enabled === true });
      if (req.method === 'GET' && url.pathname === '/api/diagnostics') return send(200, { ...diagnostics(), queue: engine.state.queue.length, status: engine.state.current?.status || 'idle', notifications: { pending: engine.state.outbox.length, failed: engine.state.deadLetters?.length || 0 }, adapter: engine.adapter.info() });
      check(req.method === 'POST', 'METHOD', 'POST 요청이 필요합니다.', 405);
      // No CORS and no credentials in query strings. Reject cross-origin browser writes.
      if (req.headers.origin) check(req.headers.origin === `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`, 'ORIGIN', '다른 사이트에서의 요청은 허용하지 않습니다.', 403);
      check(req.headers['content-type']?.startsWith('application/json'), 'CONTENT_TYPE', 'application/json을 사용하세요.', 415);
      const body = await readJson(req);
      if (url.pathname === '/api/playback-session') {
        check(engine.adapter.type === 'browser', 'ADAPTER', '브라우저 재생 모드에서 사용할 수 있습니다.');
        if (playbackSessions.size) return send(200, { token: playbackSessions.keys().next().value });
        const token = randomBytes(32).toString('base64url');
        playbackSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
        return send(200, { token });
      }
      if (url.pathname === '/api/command') return send(200, { text: await engine.command({ text: body.text, operator: true, user: 'local-admin' }) });
      if (url.pathname === '/api/retry-notifications') return send(200, await engine.serial(async () => {
        const failed = engine.state.deadLetters || [];
        check(engine.state.outbox.length + failed.length <= 500, 'OUTBOX_FULL', '대기 알림이 많습니다. 먼저 기존 알림을 처리하세요.');
        for (const item of failed) { const { failure, failedAt, ...reply } = item; engine.state.outbox.push({ ...reply, attempts: 0, nextAttemptAt: 0 }); }
        engine.state.deadLetters = []; engine.store.save(); return { requeued: failed.length };
      }));
      if (url.pathname === '/api/player/poll') return send(200, await engine.heartbeat(body.clientId));
      if (url.pathname === '/api/player/event') return send(200, await engine.playerEvent(body));
      throw new AppError('NOT_FOUND', '없는 경로입니다.', 404);
    } catch (error) {
      send(error.status || 500, { error: error.code || 'INTERNAL', message: error.status ? error.message : '내부 오류가 발생했습니다. 서버 로그를 확인하세요.' });
    }
  };
  const options = { requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeaderSize: 8192 };
  const server = tls ? https.createServer({ ...options, ...tls, minVersion: 'TLSv1.2', handshakeTimeout: 10000 }, handler) : http.createServer(options, handler);
  server.maxConnections = 128; server.maxRequestsPerSocket = 200;
  return server;
}
