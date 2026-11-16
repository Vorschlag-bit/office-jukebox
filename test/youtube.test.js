import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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

test('playlist URLs restrict hosts and reject automatic mixes', async () => {
  const { playlistId } = await import('../src/youtube.js');
  assert.equal(playlistId('https://music.youtube.com/playlist?list=PL1234567890abc'), 'PL1234567890abc');
  for (const url of ['https://evil.test/playlist?list=PL1234567890abc','http://youtube.com/playlist?list=PL1234567890abc','https://youtube.com:8443/playlist?list=PL1234567890abc','https://youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ']) assert.equal(playlistId(url), null);
});
test('playlist page parser imports ordered list items only, not recommendations or executable code', async () => {
  const { parsePlaylistPage } = await import('../src/youtube.js');
  const id='PL1234567890abc', old=(videoId,title,isPlayable=true)=>({playlistVideoRenderer:{videoId,title:{runs:[{text:title}]},isPlayable}});
  const modern=(playlistId,videoId)=>({lockupViewModel:{contentType:'LOCKUP_CONTENT_TYPE_VIDEO',rendererContext:{commandContext:{onTap:{innertubeCommand:{watchEndpoint:{playlistId,videoId}}}}},metadata:{lockupMetadataViewModel:{title:{content:'A &amp; B'}}}}});
  const data={contents:{tabs:[{playlistVideoListRenderer:{contents:[old('dQw4w9WgXcQ','first'),old('s7gef3SXSbY','private',false),old('dQw4w9WgXcQ','duplicate')]}},modern(id,'s7gef3SXSbY'),modern('other','Oq6t0wokgVw')]},recommendations:old('Oq6t0wokgVw','ignored')};
  const tracks=parsePlaylistPage(`<script>var ytInitialData = ${JSON.stringify(data)};window.followup = true;</script>`,id);
  assert.deepEqual(tracks.map(x=>[x.videoId,x.title]),[['dQw4w9WgXcQ','first'],['s7gef3SXSbY','A & B']]);
  assert.throws(()=>parsePlaylistPage('<script>var ytInitialData = {bad};</script>',id),{code:'PLAYLIST_FORMAT'});
  assert.throws(()=>parsePlaylistPage('<script>var ytInitialData = {};</script>',id),{code:'PLAYLIST_EMPTY'});
});
test('public playlist fetch is canonical, bounded, caches briefly and fails without partial imports', async () => {
  let calls=0,now=1000;const id='PL1234567890abc';
  const yt=new YouTube('',async(url,options)=>{calls++;assert.equal(url,`https://www.youtube.com/playlist?list=${id}`);assert.equal(options.redirect,'error');return new Response(`<script>var ytInitialData = ${JSON.stringify({contents:{playlistVideoListRenderer:{contents:[{playlistVideoRenderer:{videoId:'dQw4w9WgXcQ'}}]}}})};</script>`);},()=>now);
  const url=`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${id}`;
  const first=await yt.playlist(url);first[0].title='mutation';assert.notEqual((await yt.playlist(url))[0].title,'mutation');assert.equal(calls,1);
  now+=60001;await yt.playlist(url);assert.equal(calls,2);
  await assert.rejects(yt.playlist('https://evil.test/playlist?list='+id),{code:'PLAYLIST_URL'});assert.equal(calls,2);
  await assert.rejects(new YouTube('',async()=>{throw Error('offline')}).playlist(url),{code:'PLAYLIST_NETWORK'});
  await assert.rejects(new YouTube('',async()=>new Response('x'.repeat(5*1024*1024+1))).playlist(url),{code:'UPSTREAM_SIZE'});
});

test('search failures explain configuration and quota without echoing raw provider errors or credentials', async () => {
  for(const [status,body,code] of [
    [400,{error:{details:[{reason:'API_KEY_INVALID'}]}},'YOUTUBE_KEY_INVALID'],
    [403,{error:{errors:[{reason:'accessNotConfigured'}]}},'YOUTUBE_API_CONFIG'],
    [403,{error:{details:[{reason:'API_KEY_SERVICE_BLOCKED'}]}},'YOUTUBE_API_CONFIG'],
    [403,{error:{errors:[{reason:'quotaExceeded'}]}},'YOUTUBE_QUOTA'],
    [429,{},'YOUTUBE_QUOTA']
  ]) {
    let calls=0,now=0;const yt=new YouTube('private-api-key',async()=>{calls++;return new Response(JSON.stringify({...body,raw:'private-api-key'}),{status});},()=>now);
    await assert.rejects(yt.search('song'),e=>e.code===code&&!e.message.includes('private-api-key'));
    if(code==='YOUTUBE_QUOTA') {await assert.rejects(yt.search('other'),{code});assert.equal(calls,1);assert.equal((await yt.resolve('https://youtu.be/dQw4w9WgXcQ')).source,'url');now=60001;await assert.rejects(yt.search('other'),{code});assert.equal(calls,2);}
  }
});
test('concurrent identical searches share one bounded request, normalize titles and isolate cached results', async () => {
  let calls=0;const yt=new YouTube('key',async(url,options)=>{calls++;assert.equal(options.redirect,'error');assert.equal(options.headers['x-goog-api-key'],'key');assert.equal(new URL(url).searchParams.has('key'),false);assert.ok(options.signal);await new Promise(r=>setImmediate(r));return new Response(JSON.stringify({items:[{id:{videoId:'dQw4w9WgXcQ'},snippet:{title:'A\n2. injected &amp; B'}},{id:{videoId:'dQw4w9WgXcQ'},snippet:{title:'duplicate'}},{id:{videoId:'invalid'}}]}));});
  const [a,b]=await Promise.all([yt.search('some   song'),yt.search('some song')]);assert.equal(calls,1);assert.equal(a.length,1);assert.equal(a[0].title,'A 2. injected & B');a[0].title='changed';assert.notEqual(b[0].title,a[0].title);
  assert.notEqual((await yt.search('some song'))[0].title,'changed');assert.equal(calls,1);
});
test('search real loopback HTTP handles provider errors and retries after malformed responses without poisoning cache', async t => {
  const {createServer}=await import('node:http');let count=0;
  const server=createServer((req,res)=>{count++;res.setHeader('content-type','application/json');res.end(count===1?'bad-json':JSON.stringify({items:[{id:{videoId:'dQw4w9WgXcQ'},snippet:{title:'valid'}}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const yt=new YouTube('fake-key',(url,options)=>{assert.equal(new URL(url).hostname,'www.googleapis.com');return fetch(`http://127.0.0.1:${server.address().port}/provider`,options);});
  await assert.rejects(yt.search('song'),{code:'UPSTREAM_FORMAT'});assert.equal((await yt.search('song'))[0].title,'valid');assert.equal(count,2);
});

test('standalone search readiness check defaults to no network and never changes queue or prints keys', async t => {
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'jukebox-search-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'config.json'),queue=join(dir,'state.json');writeFileSync(queue,'preserved');
  const run=(args=[])=>spawnSync(process.execPath,[fileURLToPath(new URL('../bin/check-search.js',import.meta.url)),...args],{env:{...process.env,JUKEBOX_CONFIG:file},encoding:'utf8',timeout:5000});
  writeFileSync(file,JSON.stringify({youtubeApiKey:''}));assert.equal(run().status,1);
  writeFileSync(file,JSON.stringify({youtubeApiKey:'never-print-this-secret'}));const ready=run();assert.equal(ready.status,0);assert.doesNotMatch(ready.stdout+ready.stderr,/never-print-this-secret/);
  const invalid=run(['--live']);assert.equal(invalid.status,1);assert.match(invalid.stderr,/QUERY/);assert.equal(readFileSync(queue,'utf8'),'preserved');
});
