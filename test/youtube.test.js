import test from 'node:test';
import assert from 'node:assert/strict';
import { videoId, equalSecret } from '../src/util.js';
import { YouTube } from '../src/youtube.js';

for (const input of ['dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=12', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ']) test(`valid video: ${input}`, () => assert.equal(videoId(input), 'dQw4w9WgXcQ'));
for (const input of ['https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'http://youtu.be/dQw4w9WgXcQ', 'javascript:alert(1)', 'https://youtube.com/watch?v=bad', 'https://evil.test/dQw4w9WgXcQ', 'https://youtube.com/playlist?list=123']) test(`reject video: ${input}`, () => assert.equal(videoId(input), null));
test('direct video URL works without key and never fetches arbitrary hosts', async () => {
  const yt = new YouTube('', () => { throw new Error('must not fetch'); });
  assert.equal((await yt.resolve('https://youtu.be/dQw4w9WgXcQ')).videoId, 'dQw4w9WgXcQ');
  await assert.rejects(yt.resolve('https://example.com/test'), { code: 'URL' });
});
test('search without key returns actionable error', async () => { await assert.rejects(new YouTube().resolve('아이유 밤편지'), { code: 'YOUTUBE_KEY' }); });
test('optional URL titles use only canonical YouTube metadata, cache successes and fail open', async () => {
  let calls=0;
  const yt=new YouTube('',async (url,options)=>{calls++;const u=new URL(url);assert.equal(u.origin,'https://www.youtube.com');assert.equal(u.pathname,'/oembed');assert.equal(u.searchParams.get('url'),'https://www.youtube.com/watch?v=dQw4w9WgXcQ');assert.equal(options.redirect,'error');return {ok:true,json:async()=>({title:'Music &amp; friends'})};},Date.now,{resolveTitles:true});
  assert.equal((await yt.resolve('https://youtu.be/dQw4w9WgXcQ?list=unused')).title,'Music & friends');
  await yt.resolve('https://youtu.be/dQw4w9WgXcQ');assert.equal(calls,1);
  const offline=new YouTube('',async()=>{throw Error('offline');},Date.now,{resolveTitles:true});
  assert.equal((await offline.resolve('https://youtu.be/dQw4w9WgXcQ')).videoId,'dQw4w9WgXcQ');
  await assert.rejects(yt.resolve('https://evil.example/dQw4w9WgXcQ'),{code:'URL'});assert.equal(calls,1);
});
test('search has embedding filters and bounded TTL cache', async () => {
  let calls = 0, now = 1000;
  const yt = new YouTube('test-key', async url => { calls++; const u = new URL(url); assert.equal(u.searchParams.get('videoEmbeddable'), 'true'); assert.equal(u.searchParams.get('type'), 'video'); return { ok: true, status: 200, json: async () => ({ items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'test' } }] }) }; }, () => now);
  await yt.resolve('song'); await yt.resolve('song'); assert.equal(calls, 1);
  now += 3600001; await yt.resolve('song'); assert.equal(calls, 2);
});
test('native app search need not restrict embeddings', async () => {
  const yt = new YouTube('key', async url => { assert.equal(new URL(url).searchParams.has('videoEmbeddable'), false); return { ok: true, json: async () => ({ items: [] }) }; });
  await assert.rejects(yt.resolve('song', false), { code: 'NOT_FOUND' });
});
test('quota failures become recoverable upstream errors without leaking API key', async () => {
  const yt = new YouTube('SECRET_KEY', async () => ({ ok: false, status: 403 }));
  await assert.rejects(yt.resolve('song'), e => e.code === 'UPSTREAM' && !e.message.includes('SECRET_KEY'));
});
test('constant-time secret comparator handles missing and unequal length inputs', () => {
  assert.equal(equalSecret(undefined, undefined), false); assert.equal(equalSecret('abc', 'abcd'), false); assert.equal(equalSecret('abc', 'abc'), true);
});
