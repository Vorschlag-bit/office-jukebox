import { AppError, check, jsonFetch, videoId } from './util.js';

export class YouTube {
  constructor(key = '', fetcher = fetch, now = Date.now) { this.key = key; this.fetcher = fetcher; this.now = now; this.cache = new Map(); }
  async resolve(query, embedded = true) {
    check(typeof query === 'string' && query.trim().length > 0 && query.length <= 300, 'QUERY', '곡명 또는 유튜브 URL을 300자 이내로 입력하세요.');
    query = query.trim();
    const id = videoId(query);
    if (id) return { videoId: id, title: `YouTube ${id}`, source: 'url' };
    if (/^https?:\/\//i.test(query)) throw new AppError('URL', '유효한 HTTPS 유튜브 영상 URL만 신청할 수 있습니다.');
    check(this.key, 'YOUTUBE_KEY', '곡명 검색에는 YouTube API 키가 필요합니다. URL 직접 신청은 키 없이 가능합니다.');
    const cacheKey = `${embedded}:${query.toLowerCase()}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > this.now()) return structuredClone(hit.track);
    const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '5', q: query, key: this.key, safeSearch: 'moderate' });
    if (embedded) { params.set('videoEmbeddable', 'true'); params.set('videoSyndicated', 'true'); }
    const data = await jsonFetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {}, this.fetcher);
    const item = data.items?.find(x => videoId(x.id?.videoId || ''));
    check(item, 'NOT_FOUND', '검색 결과가 없습니다. 유튜브 URL로 신청해 주세요.');
    const track = { videoId: item.id.videoId, title: String(item.snippet?.title || query).slice(0, 300), source: 'search' };
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(cacheKey, { track, expires: this.now() + 3600000 });
    return structuredClone(track);
  }
}
