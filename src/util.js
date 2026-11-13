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
  const response = await fetcher(url, { ...options, signal: options.signal || AbortSignal.timeout(12000) });
  if (!response.ok) throw new AppError('UPSTREAM', `외부 서비스 응답 오류: HTTP ${response.status}`, 502);
  if (response.status === 204) return {};
  return response.json();
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
