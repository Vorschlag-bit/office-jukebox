import { timingSafeEqual } from 'node:crypto';

export class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function check(condition, code, message, status) {
  if (!condition) throw new AppError(code, message, status);
}
export function equalSecret(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
export async function jsonFetch(url, options = {}, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...options, signal: options.signal || AbortSignal.timeout(12000) }); }
  catch { throw new AppError('NETWORK', '외부 서비스 연결에 실패했습니다. 잠시 후 재시도하세요.', 502); }
  if (!response.ok) {
    const error = new AppError('UPSTREAM', `외부 서비스 응답 오류: HTTP ${response.status}`, 502);
    error.upstreamStatus = response.status;
    throw error;
  }
  if (response.status === 204) return {};
  try { return response.text ? JSON.parse(await boundedText(response)) : await response.json(); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('UPSTREAM_FORMAT', '외부 서비스에서 잘못된 JSON을 반환했습니다.', 502); }
}
export async function boundedText(response, maxBytes = 1048576) {
  if (!response.body?.getReader) {
    const result = await response.text();
    check(Buffer.byteLength(result) <= maxBytes, 'UPSTREAM_SIZE', '외부 서비스 응답 크기 초과', 502);
    return result;
  }
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      check(bytes <= maxBytes, 'UPSTREAM_SIZE', '외부 서비스 응답 크기 초과', 502);
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
export function videoId(input) {
  if (videoIdPattern.test(input)) return input;
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  let id;
  if (u.hostname === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(u.hostname)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (/^\/(shorts|embed|live)\//.test(u.pathname)) id = u.pathname.split('/')[2];
  }
  return videoIdPattern.test(id || '') ? id : null;
}
export function watchUrl(id) { return `https://www.youtube.com/watch?v=${id}`; }
