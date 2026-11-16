import { AppError, check, jsonFetch, videoId, boundedText } from './util.js';

export function playlistId(input) {
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(u.hostname)) return null;
    const id = u.searchParams.get('list');
    return /^(PL|UU|LL|FL|OLAK5uy_)[A-Za-z0-9_-]{10,150}$/.test(id || '') ? id : null;
  } catch { return null; }
}

// Read data only, never execute page scripts. Scope to playlist contents, not recommendations.
export function parsePlaylistPage(html, id) {
  const match = /(?:\bvar\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=)\s*\{/.exec(html);
  let data;
  try {
    if (!match) throw Error('missing');
    const start = match.index + match[0].length - 1;
    let depth = 0, quoted = false, escaped = false, end = start;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) break;
    }
    data = JSON.parse(html.slice(start, end + 1));
  } catch { throw new AppError('PLAYLIST_FORMAT', '재생목록을 읽지 못했어요. YouTube 화면 변경 또는 접근 제한일 수 있어요.'); }
  const songs = [], seen = new Set();
  function add(video, title) {
    if (!videoId(video || '') || seen.has(video) || songs.length >= 100) return;
    seen.add(video); songs.push({ videoId: video, title: decodeTitle(String(title || `YouTube ${video}`)).slice(0, 300), source: 'playlist' });
  }
  function walk(node, inList = false) {
    if (!node || typeof node !== 'object') return;
    if (node.playlistVideoListRenderer) { walk(node.playlistVideoListRenderer.contents, true); return; }
    const old = node.playlistVideoRenderer;
    if (old && inList) { if (old.isPlayable !== false) add(old.videoId, old.title?.simpleText || old.title?.runs?.map(x => x.text).join('')); return; }
    const item = node.lockupViewModel;
    if (item) {
      const endpoint = item.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
      if (item.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && endpoint?.playlistId === id) add(endpoint.videoId, item.metadata?.lockupMetadataViewModel?.title?.content);
      return;
    }
    for (const value of Object.values(node)) walk(value, inList);
  }
  walk(data.contents);
  check(songs.length, 'PLAYLIST_EMPTY', '공개된 재생 가능한 곡을 찾지 못했어요. 비공개·삭제된 목록, 자동 믹스는 지원하지 않습니다.');
  return songs;
}

export class YouTube {
  constructor(key = '', fetcher = fetch, now = Date.now, { resolveTitles = false } = {}) { this.key = key; this.fetcher = fetcher; this.now = now; this.cache = new Map(); this.resolveTitles = resolveTitles; }
  async playlist(input) {
    const id = playlistId(input);
    check(id, 'PLAYLIST_URL', '공유된 YouTube 재생목록 링크를 넣어 주세요. 자동 믹스·라디오는 지원하지 않습니다.');
    const hit = this.cache.get(`playlist:${id}`);
    if (hit && hit.expires > this.now()) return structuredClone(hit.tracks);
    let response;
    try { response = await this.fetcher(`https://www.youtube.com/playlist?list=${id}`, { redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new AppError('PLAYLIST_NETWORK', '재생목록 연결에 실패했어요. 잠시 후 다시 시도해 주세요.', 502); }
    check(response.ok, 'PLAYLIST_HTTP', '재생목록을 열지 못했어요. 공개 또는 링크 공유 목록인지 확인해 주세요.', 502);
    const tracks = parsePlaylistPage(await boundedText(response, 5 * 1024 * 1024), id);
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(`playlist:${id}`, { tracks, expires: this.now() + 60000 });
    return structuredClone(tracks);
  }
  async resolve(query, embedded = true) {
    return (await this.search(query, embedded))[0];
  }
  async search(query, embedded = true) {
    check(typeof query === 'string' && query.trim().length > 0 && query.length <= 300, 'QUERY', '곡명 또는 유튜브 URL을 300자 이내로 입력하세요.');
    query = query.trim();
    const id = videoId(query);
    if (id) {
      let title = `YouTube ${id}`;
      if (this.resolveTitles) {
        const cacheKey = `url:${id}`, hit = this.cache.get(cacheKey);
        if (hit && hit.expires > this.now()) title = hit.title;
        else {
          try {
            const url = new URL('https://www.youtube.com/oembed');
            url.searchParams.set('url', `https://www.youtube.com/watch?v=${id}`); url.searchParams.set('format', 'json');
            const metadata = await jsonFetch(url.href, { signal: AbortSignal.timeout(4000), redirect: 'error' }, this.fetcher);
            if (typeof metadata.title === 'string' && metadata.title.trim()) title = decodeTitle(metadata.title).slice(0, 300);
          } catch { /* Metadata is optional; a title lookup failure never rejects a valid video URL. */ }
          if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
          this.cache.set(cacheKey, { title, expires: this.now() + (title === `YouTube ${id}` ? 60000 : 3600000) });
        }
      }
      return [{ videoId: id, title, source: 'url' }];
    }
    if (/^https?:\/\//i.test(query)) throw new AppError('URL', '유효한 HTTPS 유튜브 영상 URL만 신청할 수 있습니다.');
    check(this.key, 'YOUTUBE_KEY', '곡명 검색에는 YouTube API 키가 필요합니다. URL 직접 신청은 키 없이 가능합니다.');
    const cacheKey = `${embedded}:${query.toLowerCase()}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > this.now()) return structuredClone(hit.tracks);
    const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '5', q: query, safeSearch: 'moderate' });
    if (embedded) { params.set('videoEmbeddable', 'true'); params.set('videoSyndicated', 'true'); }
    const data = await jsonFetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { redirect: 'error', headers: { 'x-goog-api-key': this.key } }, this.fetcher);
    const items = data.items?.filter(x => videoId(x.id?.videoId || '')).slice(0, 5) || [];
    check(items.length, 'NOT_FOUND', '검색 결과가 없습니다. 유튜브 URL로 신청해 주세요.');
    const tracks = items.map(item => ({ videoId: item.id.videoId, title: decodeTitle(String(item.snippet?.title || query)).slice(0, 300), source: 'search' }));
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(cacheKey, { tracks, expires: this.now() + 3600000 });
    return structuredClone(tracks);
  }
}
export function decodeTitle(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);/gi, value => {
    const fixed = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
    if (fixed[value.toLowerCase()]) return fixed[value.toLowerCase()];
    const cp = value[2].toLowerCase() === 'x' ? parseInt(value.slice(3, -1), 16) : parseInt(value.slice(2, -1), 10);
    return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : value;
  });
}
