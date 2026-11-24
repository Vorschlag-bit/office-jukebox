import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { MemoryStore, validateState } from '../src/store.js';
import { backgroundTrack, seasonAt, BACKGROUND_CATALOG } from '../src/background.js';
function setup(options={}) {
  let now=Date.parse('2026-11-16T01:00:00Z'),listener;
  const calls=[],store=new MemoryStore();
  const adapter={type:'lounge',info:()=>({type:'lounge'}),setListener:f=>listener=f,play:async song=>{calls.push(['play',song.videoId]);return {confirmed:false};},stop:async()=>calls.push(['stop']),pause:async()=>calls.push(['pause']),resume:async()=>calls.push(['resume']),...options.adapter};
  const youtube={resolve:async()=>({videoId:'dQw4w9WgXcQ',title:'request',source:'url'}),playlist:async()=>[{videoId:'dQw4w9WgXcQ',title:'first',source:'playlist'},{videoId:'s7gef3SXSbY',title:'second',source:'playlist'}]};
  const engine=new Engine({...options,store,adapter,youtube,now:()=>now,background:options.background || {enabled:true},autoSkipUnplayable:true});
  const emit=async event=>{listener({...engine.state.current,event,verifiedObservation:true});await engine.chain;};
  return {engine,store,adapter,calls,emit,advance:ms=>{now+=ms;}};
}
test('season and year follow Seoul calendar at every boundary; curated choices vary without search',()=>{
  for(const [date,season] of [['2026-02-28T14:59:59Z','winter'],['2026-02-28T15:00:00Z','spring'],['2026-05-31T15:00:00Z','summer'],['2026-08-31T15:00:00Z','autumn'],['2026-11-30T15:00:00Z','winter']])assert.equal(seasonAt(Date.parse(date)).season,season);
  assert.equal(seasonAt(Date.parse('2026-12-31T15:00:00Z')).year,2027);
  for(const songs of Object.values(BACKGROUND_CATALOG)){assert.ok(songs.length>=2);for(const s of songs)assert.match(s.videoId,/^[\w-]{11}$/);}
  assert.notEqual(backgroundTrack(Date.parse('2026-11-16'),0).videoId,backgroundTrack(Date.parse('2026-11-16'),1).videoId);
});
test('empty queue starts seasonal background outside request quota, only actual playing confirms it',async()=>{
  const {engine,calls,emit}=setup();await engine.start();assert.equal(engine.state.queue.length,0);assert.equal(engine.state.current.source,'background');assert.match(engine.state.current.title,/2026 가을/);assert.equal(engine.state.current.status,'sent_unconfirmed');assert.equal(calls.length,1);validateState(engine.state);
  await emit('playing');assert.equal(engine.state.current.status,'playing');assert.equal(engine.state.outbox.length,0);
  const first=engine.state.current.videoId;await emit('idle');assert.notEqual(engine.state.current.videoId,first);assert.equal(engine.state.history[0].status,'tv_idle');
});
test('new requests preempt confirmed background, preserve FIFO, and idle refills background after their true end',async()=>{
  const {engine,emit}=setup();await engine.start();await emit('playing');const bg=engine.state.current.sessionId;
  await engine.command({text:'추가 url',user:'one'});assert.equal(engine.state.current.source,'url');assert.equal(engine.state.history[0].status,'background_yielded');const first=engine.state.current.id;
  await engine.command({text:'추가 url',user:'two'});const next=engine.state.queue[0].id;
  await engine.nativeEvent({sessionId:bg,videoId:'aUrDBUaabBU',event:'ended',verifiedObservation:true});assert.equal(engine.state.current.id,first);
  await emit('playing');await emit('ended');assert.equal(engine.state.current.id,next);await emit('playing');await emit('ended');assert.equal(engine.state.current.source,'background');
});
test('request while background awaits handshake yields after actual playback without losing the request',async()=>{
  const {engine,emit}=setup();await engine.start();await engine.command({text:'추가 url'});assert.equal(engine.state.current.source,'background');assert.equal(engine.state.queue.length,1);await emit('playing');assert.equal(engine.state.current.source,'url');assert.equal(engine.state.queue.length,0);
});
test('playlist preempts background only after import and keeps every requested item in order',async()=>{
  const {engine,emit}=setup();await engine.start();await emit('playing');await engine.command({text:'목록 https://youtube.com/playlist?list=PL1234567890abc'});assert.equal(engine.state.current.title,'first');assert.equal(engine.state.queue[0].title,'second');
});
test('stop suppresses background across polls and restart until resume or a new request',async()=>{
  const {engine,store,adapter,calls,emit}=setup();await engine.start();await emit('playing');await engine.command({text:'정지',operator:true});assert.equal(engine.state.current,null);assert.equal(engine.state.backgroundSuppressed,true);const count=calls.length;
  const restored=new Engine({store,adapter,youtube:engine.youtube,background:{enabled:true}});await restored.start();await restored.command({text:'상태'});await restored.tick();assert.equal(calls.length,count);assert.equal(store.state.current,null);
  await restored.command({text:'계속',operator:true});assert.equal(store.state.current.source,'background');
});
test('pause and external TV control never get overwritten by background or new requests',async()=>{
  const {engine,emit,calls}=setup();await engine.start();await emit('playing');await engine.command({text:'일시정지',operator:true});await engine.command({text:'추가 url'});assert.equal(engine.state.current.source,'background');assert.equal(engine.state.queue.length,1);
  await engine.command({text:'계속',operator:true});assert.equal(engine.state.current.source,'url');
  const other=setup();await other.engine.start();await other.emit('playing');await other.emit('external');const count=other.calls.length;await other.engine.command({text:'추가 url'});await other.engine.tick();assert.equal(other.calls.length,count);assert.equal(other.engine.state.current.status,'recovery_required');assert.equal(other.engine.state.queue.length,1);
});
test('background browser errors are bounded and network uncertainty never loops launches',async()=>{
  const {engine,calls,advance}=setup();await engine.start();advance(46000);await engine.tick();assert.equal(engine.state.current.status,'error');for(let i=0;i<10;i++)await engine.tick();assert.equal(calls.length,1);
  const x=setup();await x.engine.start();for(let i=0;i<3;i++){await x.engine.serial(()=>x.engine.applyPlayback('error',150));}assert.equal(x.engine.state.paused,true);assert.equal(x.engine.state.current,null);assert.equal(x.calls.filter(x=>x[0]==='play').length,3);
});
test('browser background waits for its player and restart attaches without replay',async()=>{
  const x=setup({adapter:{type:'browser'}});await x.engine.start();assert.equal(x.calls.length,0);await x.engine.heartbeat('browser-player');assert.equal(x.engine.state.current.source,'background');
  const original=x.engine.state.current.id,count=x.calls.length;
  const restarted=new Engine({store:x.store,adapter:x.adapter,youtube:x.engine.youtube,background:{enabled:true}});await restarted.start();assert.equal(x.calls.length,count);assert.equal(restarted.state.current.id,original);assert.equal(restarted.state.current.status,'recovery_required');
});
test('background is disabled by default and unsupported native launches do not loop',async()=>{
  const x=setup({background:{enabled:false}});await x.engine.start();assert.equal(x.calls.length,0);
  const y=setup({adapter:{type:'samsung'}});await y.engine.start();assert.equal(y.calls.length,0);
});

test('request batch returns to interrupted manual song at its observed position, then falls back to seasonal BGM',async()=>{
 const {engine,emit}=setup();await engine.start();await emit('playing');await engine.nativeEvent({...engine.state.current,event:'external',verifiedObservation:true,observedVideoId:'aaaaaaaaaaa',observationSessionId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',observedState:1,positionSeconds:123.5,durationSeconds:3600});
 assert.equal(engine.state.current.source,'external_tv');await engine.command({text:'목록 https://youtube.com/playlist?list=PL1234567890abc'});assert.equal(engine.state.manualReturn.videoId,'aaaaaaaaaaa');assert.equal(engine.state.manualReturn.resumePositionSeconds,123.5);assert.equal(engine.state.current.title,'first');
 await emit('playing');await emit('ended');assert.equal(engine.state.current.title,'second');await emit('playing');await emit('ended');assert.equal(engine.state.current.source,'external_tv');assert.equal(engine.state.current.videoId,'aaaaaaaaaaa');assert.equal(engine.state.current.resumePositionSeconds,123.5);assert.equal(engine.state.manualReturn,null);assert.equal(engine.state.current.status,'sent_unconfirmed');
 await emit('playing');await emit('ended');assert.equal(engine.state.current.source,'background');validateState(engine.state);
});
test('manual return survives restart during a request and never replays an unconfirmed launch',async()=>{
 const {engine,adapter,store,emit,calls}=setup();await engine.start();await emit('playing');await engine.nativeEvent({...engine.state.current,event:'external',verifiedObservation:true,observedVideoId:'aaaaaaaaaaa',observationSessionId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',observedState:1,positionSeconds:30,durationSeconds:300});await engine.command({text:'추가 one'});const request=engine.state.current.id,count=calls.length;
 const restored=new Engine({store,adapter,youtube:engine.youtube,now:engine.now,background:{enabled:true}});await restored.start();assert.equal(calls.length,count);assert.equal(store.state.current.id,request);assert.equal(store.state.manualReturn.videoId,'aaaaaaaaaaa');assert.equal(store.state.current.status,'recovery_required');
 await restored.nativeEvent({...store.state.current,event:'playing',verifiedObservation:true});await restored.nativeEvent({...store.state.current,event:'ended',verifiedObservation:true});assert.equal(store.state.current.videoId,'aaaaaaaaaaa');assert.equal(store.state.current.resumePositionSeconds,30);validateState(store.state);
});
test('stop clears manual return; absent/expired return uses BGM, and live position is not treated as a seek target',async()=>{
 const a=setup();await a.engine.start();await a.emit('playing');await a.engine.nativeEvent({...a.engine.state.current,event:'external',verifiedObservation:true,observedVideoId:'aaaaaaaaaaa',observationSessionId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',observedState:1,positionSeconds:100,durationSeconds:0});await a.engine.command({text:'추가 one'});assert.equal(a.store.state.manualReturn.resumePositionSeconds,0);await a.engine.command({text:'정지',operator:true});assert.equal(a.store.state.manualReturn,null);await a.engine.command({text:'계속',operator:true});assert.equal(a.store.state.current.source,'background');
 const b=setup();b.store.state.manualReturn={id:'expired',videoId:'aaaaaaaaaaa',title:'old',source:'external_tv',expiresAt:0,resumePositionSeconds:1};await b.engine.start();assert.equal(b.store.state.current.source,'background');assert.equal(b.store.state.manualReturn,null);
});
test('later manual selection replaces return target; positions from stale sessions cannot corrupt it',async()=>{
 const {engine,emit}=setup();await engine.start();await emit('playing');const observe=async(video,id)=>engine.nativeEvent({...engine.state.current,event:'external',verifiedObservation:true,observedVideoId:video,observationSessionId:id,observedState:1,positionSeconds:10,durationSeconds:100});await observe('aaaaaaaaaaa','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');await engine.command({text:'추가 one'});await observe('bbbbbbbbbbb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');await engine.nativeEvent({...engine.state.current,event:'position',verifiedObservation:true,positionSeconds:22,durationSeconds:100});const old={...engine.state.current};await engine.command({text:'추가 two'});assert.equal(engine.state.manualReturn.videoId,'bbbbbbbbbbb');assert.equal(engine.state.manualReturn.resumePositionSeconds,22);await engine.nativeEvent({...old,event:'position',verifiedObservation:true,positionSeconds:99});assert.equal(engine.state.manualReturn.resumePositionSeconds,22);
});

test('manual selection during the last request discards the older return intent',async()=>{
 const {engine,emit}=setup();await engine.start();await emit('playing');const observe=(video,id)=>engine.nativeEvent({...engine.state.current,event:'external',verifiedObservation:true,observedVideoId:video,observationSessionId:id,observedState:1});await observe('aaaaaaaaaaa','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');await engine.command({text:'추가 one'});assert.ok(engine.state.manualReturn);await observe('bbbbbbbbbbb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');assert.equal(engine.state.manualReturn,null);await emit('ended');assert.equal(engine.state.current.source,'background');
});
