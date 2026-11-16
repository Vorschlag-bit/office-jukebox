// Curated instrumental videos: no runtime search API calls or recommendations.
// Selection sources and update limits are documented in docs/BACKGROUND.md.
export const BACKGROUND_CATALOG = Object.freeze({
  spring: [{ videoId: 'WzDW18V4NMU', title: 'Spring Jazz & Bossa Nova · Smooth Piano' }, { videoId: '1K60aE2sbws', title: 'Spring Jazz · Coffee Shop' }],
  summer: [{ videoId: 'iRKl-o5UBxw', title: 'Summer Jazz · Relaxing Piano' }, { videoId: 'pMy6D1aIllE', title: 'Summer Jazz · Positive Morning' }],
  autumn: [{ videoId: 'aUrDBUaabBU', title: 'Autumn Jazz Piano · Work & Focus' }, { videoId: 'BDiYdN3bwIo', title: 'Autumn Smooth Jazz Piano · Coffee Shop' }],
  winter: [{ videoId: 'E_SdCTiZw0Q', title: 'Winter Jazz Piano · Cozy Café' }, { videoId: 'ibiQgq4uOV8', title: 'Winter Jazz Piano · Snowy Evening' }]
});
export function seasonAt(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric' }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  const month = Number(parts.month), season = month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter';
  return { year: Number(parts.year), season, label: { spring: '봄', summer: '여름', autumn: '가을', winter: '겨울' }[season] };
}
export function backgroundTrack(now, index = 0) {
  const { year, season, label } = seasonAt(now), songs = BACKGROUND_CATALOG[season];
  const song = songs[index % songs.length];
  return { videoId: song.videoId, title: `[자동 BGM · ${year} ${label}] ${song.title}`, source: 'background' };
}
