// Optional readiness check. No server start, TV commands or queue writes.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YouTube } from '../src/youtube.js';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const config = JSON.parse(readFileSync(process.env.JUKEBOX_CONFIG || resolve(base, 'config.local.json'), 'utf8'));
  if (!config.youtubeApiKey) {
    console.log('YOUTUBE_KEY: API 키 미설정. 검색 비활성화, URL 신청 가능. 서버·TV·대기열 변경 없음.');
    process.exitCode = 1;
  } else if (process.argv[2] !== '--live') {
    console.log('API 키 설정 있음. 실제 유효성은 미확인. 실제 검색 1회를 시험하려면 --live "곡명"을 지정하세요.');
  } else {
    const songs = await new YouTube(config.youtubeApiKey).search(process.argv.slice(3).join(' '), config.adapter?.type === 'browser');
    console.log(`검색 API 응답 확인: 후보 ${songs.length}개. 아직 TV 재생 검증은 아닙니다. 서버·대기열 변경 없음.`);
  }
} catch (error) {
  const known = new Set(['QUERY','YOUTUBE_KEY','YOUTUBE_KEY_INVALID','YOUTUBE_API_CONFIG','YOUTUBE_QUOTA','NETWORK','NOT_FOUND','UPSTREAM','UPSTREAM_FORMAT']);
  console.error(`${known.has(error.code) ? error.code : 'SEARCH_CHECK'}: ${known.has(error.code) ? error.message : '설정 파일과 검색 준비 상태를 확인하세요.'}`);
  process.exitCode = 1;
}
