import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AppsScriptWorker, validateBridge } from '../src/apps-script.js';
import { MemoryStore } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { YouTube } from '../src/youtube.js';

const secret = 'test-only-not-a-live-secret-1234567890';
const config = () => ({ transport: 'apps-script', sharedSecret: secret, scriptUrl: 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec', allowedSpaces: ['spaces/test'], operatorUsers: ['users/operator'], pollIntervalMs: 5000 });
function runtime() {
  let at = Date.now(), locked = false;
  const props = new Map([['SHARED_SECRET', secret], ['ALLOWED_SPACES', '["spaces/test"]']]), cache = new Map();
  const p = { getProperty: k => props.get(k) ?? null, setProperty(k,v) { assert.ok(Buffer.byteLength(v) <= 9000, `property too large: ${k}`); props.set(k,v); assert.ok([...props.values()].reduce((n,v) => n+Buffer.byteLength(v),0) < 500000); }, deleteProperty: k => props.delete(k) };
  const context = vm.createContext({ Date: class extends Date { static now() { return at; } }, PropertiesService: { getScriptProperties: () => p }, LockService: { getScriptLock: () => ({ tryLock() { if (locked) return false; locked=true; return true; }, releaseLock() { locked=false; } }) }, CacheService: { getScriptCache: () => ({ get(k) { const v=cache.get(k); return v && v.until>at ? v.value : null; }, put(k,value,seconds) { cache.set(k,{value,until:at+seconds*1000}); } }) }, Utilities: { Charset: {UTF_8:'utf8'}, DigestAlgorithm: {SHA_256:'sha256'}, computeDigest: (_,s) => [...createHash('sha256').update(s).digest()], computeHmacSha256Signature: (s,key) => [...createHmac('sha256',key).update(s).digest()], getUuid: randomUUID }, ContentService: { MimeType:{JSON:'application/json'}, createTextOutput: text => ({ text, setMimeType() { return this; } }) } });
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs',import.meta.url),'utf8'),context);
  const envelope = (op,data={}) => { const r={v:1,ts:at,nonce:randomUUID(),op,payload:JSON.stringify(data)}; r.signature=createHmac('sha256',secret).update(`1\n${r.ts}\n${r.nonce}\n${r.op}\n${r.payload}`).digest('hex'); return r; };
  const post = r => JSON.parse(context.doPost({postData:{contents:JSON.stringify(r)}}).text);
  const event = (text, id=randomUUID(), user='users/test', space='spaces/test') => ({type:'MESSAGE',eventTime:new Date(at).toISOString(),space:{name:space},user:{name:user,type:'HUMAN'},message:{name:`${space}/messages/${id}`,argumentText:text,sender:{name:user,type:'HUMAN'}}});
  return { context, props, envelope, post, call:(op,data)=>post(envelope(op,data)), event, message:(...a)=>context.onMessage(event(...a)).text, advance: ms=>{at+=ms;}, now:()=>at };
}
function worker(engine, r, fetcher) { return new AppsScriptWorker({config:config(),engine,now:r.now,fetcher:fetcher || (async (_,options)=>new Response(r.context.doPost({postData:{contents:options.body}}).text,{headers:{'Content-Type':'application/json'}})),log:()=>{}}); }
function engine(r) { return new Engine({store:new MemoryStore(),youtube:new YouTube(),adapter:{type:'browser',info:()=>({type:'browser'}),play:async()=>({confirmed:false}),stop:async()=>{}},now:r.now}); }

test('Apps Script default manifest grants no OAuth scopes or external services', () => {
  const manifest=JSON.parse(readFileSync(new URL('../apps-script/appsscript.json',import.meta.url)));
  assert.deepEqual(manifest.oauthScopes,[]); assert.deepEqual(manifest.dependencies,{});
  assert.doesNotMatch(readFileSync(new URL('../apps-script/Code.gs',import.meta.url),'utf8'),/UrlFetchApp|ScriptApp\.getOAuthToken|eval\(/);
});
test('cost policy rejects old Pub/Sub config, unexpected URL and weak secrets', () => {
  assert.doesNotThrow(()=>validateBridge(config()));
  for (const patch of [{transport:'pubsub'},{subscription:'projects/test/subscriptions/test'},{serviceAccountFile:'credentials.local.json'}]) assert.throws(()=>validateBridge({...config(),...patch}),{code:'COST_POLICY'});
  for (const patch of [{scriptUrl:'http://script.google.com/macros/s/test/exec'},{scriptUrl:'https://evil.invalid/exec'},{scriptUrl:'https://script.google.com/macros/s/test/dev'},{sharedSecret:'short'},{pollIntervalMs:1000}]) assert.throws(()=>validateBridge({...config(),...patch}),{code:'CONFIG'});
});
test('HMAC authenticates exact body; replay, stale timestamp, malformed and unknown operation rejected', () => {
  const r=runtime(), request=r.envelope('check');
  assert.equal(r.post(request).ok,true); assert.equal(r.post(request).ok,false);
  for (const field of ['payload','op','nonce','signature']) { const x=r.envelope('check'); x[field]+='x'; assert.equal(r.post(x).ok,false); }
  const old=r.envelope('check'); r.advance(61000); assert.equal(r.post(old).ok,false);
  assert.equal(r.call('enqueue',{text:'stop'}).ok,false);
  assert.equal(JSON.parse(r.context.doPost({postData:{contents:'bad json'}}).text).ok,false);
  assert.equal(JSON.parse(r.context.doPost({postData:{contents:'x'.repeat(16001)}}).text).ok,false);
});
test('Chat setup ID discovery is read-only; default deny, bot ignore, limits and age checks', () => {
  const r=runtime(); r.props.delete('ALLOWED_SPACES');
  assert.match(r.message('내정보'),/spaces\/test/); assert.match(r.message('정지'),/허용되지/); assert.equal(r.props.has('QUEUE'),false);
  r.props.set('ALLOWED_SPACES','["spaces/test"]');
  assert.match(r.message('x'.repeat(501)),/500/); assert.match(r.message('정지',undefined,'users/stranger','spaces/other'),/허용되지/);
  const e=r.event('정지'); e.message.sender.type='BOT'; assert.match(r.context.onMessage(e).text,/지원하지/);
  const stale=r.event('정지'); r.advance(300001); assert.match(r.context.onMessage(stale).text,/만료/);
  r.props.delete('SHARED_SECRET'); assert.match(r.message('정지'),/SHARED_SECRET/);
});
test('Chat addon payload and annotation fallback normalize mentions without guessing names', () => {
  const r=runtime(), e=r.event('내정보');
  assert.match(r.context.onMessage({chat:{eventTime:e.eventTime,messagePayload:{space:e.space,message:e.message}}}).text,/users\/test/);
  delete e.message.argumentText; e.message.text='@Bot 내정보'; e.message.annotations=[{type:'USER_MENTION',startIndex:0,length:4,userMention:{user:{type:'BOT'}}}];
  assert.match(r.context.onMessage(e).text,/users\/test/);
});
test('command is deduplicated, leased, retained until matching ACK, then not re-enqueued', () => {
  const r=runtime(); assert.match(r.message('대기열','same'),/접수/); assert.match(r.message('대기열','same'),/이미/);
  const clientId=randomUUID(), other=randomUUID();
  const first=r.call('pull',{clientId}).command; assert.equal(first.text,'대기열');
  assert.equal(r.call('pull',{clientId}).command,null); assert.equal(r.call('pull',{clientId:other}).ok,false);
  assert.equal(r.call('ack',{clientId,id:first.id,lease:'wrong'}).ok,false);
  r.advance(30001); const again=r.call('pull',{clientId}).command; assert.notEqual(first.lease,again.lease);
  assert.equal(r.call('ack',{clientId,id:first.id,lease:first.lease}).ok,false);
  assert.equal(r.call('ack',{clientId,id:again.id,lease:again.lease}).ok,true);
  assert.equal(r.call('pull',{clientId}).command,null); assert.match(r.message('대기열','same'),/이미/);
});
test('bounded properties survive Korean queue and result volume; TTL frees capacity', () => {
  const r=runtime();
  for(let i=0;i<50;i++) assert.match(r.message('가'.repeat(500),`id${i}`),/접수/);
  assert.match(r.message('대기열','overflow'),/가득/);
  for(let i=0;i<130;i++) assert.equal(r.call('result',{id:`result-${i}`,space:'spaces/test',user:`users/user${i}`,text:'한'.repeat(1500)}).ok,true);
  assert.ok(JSON.parse(r.props.get('RESULTS')).length<=50); assert.ok(JSON.parse(r.props.get('RECEIPTS')).length<=100);
  r.advance(300001); assert.match(r.message('대기열','new'),/접수/); assert.equal(JSON.parse(r.props.get('QUEUE')).length,1);
});
test('result cache is user/space scoped, escaped, idempotent and visibly timestamped', () => {
  const r=runtime(), data={id:'reply1',space:'spaces/test',user:'users/test',text:'<users/all> 테스트'};
  assert.equal(r.call('result',data).ok,true); assert.match(r.message('결과'),/‹users\/all›/); assert.match(r.message('결과'),/처리 결과/);
  assert.equal(r.call('result',{...data,text:'duplicate must not overwrite'}).ok,true); assert.doesNotMatch(r.message('결과'),/overwrite/);
  assert.match(r.message('결과',undefined,'users/other'),/아직/);
  assert.equal(r.call('result',{...data,space:'spaces/other'}).ok,false);
  r.advance(86400001); assert.match(r.message('결과'),/아직/);
});
test('worker roundtrip persists command, ACKs and returns result without SA JSON or webhook', async () => {
  const r=runtime(), e=engine(r), w=worker(e,r);
  assert.equal((await w.check()).ok,true);
  r.message('추가 https://youtu.be/dQw4w9WgXcQ','song'); await w.cycle();
  assert.equal(e.state.queue.length,1); assert.equal(e.state.outbox.length,0); assert.match(r.message('결과'),/추가|대기열/);
  assert.equal(e.state.queue[0].requestedBy,'users/test');
  // Lost ACK / redelivery is suppressed by durable engine event ID.
  const id=Object.keys(e.state.seen)[0];
  await w.receive({message:{data:Buffer.from(JSON.stringify({type:'MESSAGE',eventTime:new Date(r.now()).toISOString(),space:{name:'spaces/test'},user:{name:'users/test'},message:{name:id,argumentText:'추가 https://youtu.be/dQw4w9WgXcQ'}})).toString('base64')}});
  assert.equal(e.state.queue.length,1); w.stop();
});
test('worker enforces operator IDs and returns durable validation errors through result cache', async () => {
  const r=runtime(), e=engine(r), w=worker(e,r);
  r.message('정지'); await w.cycle(); assert.match(r.message('결과'),/권한|운영자/);
  r.message('추가 노래명'); await w.cycle(); assert.match(r.message('결과'),/API 키/);
  assert.equal(e.state.outbox.length,0); w.stop();
});

test('actual engine playback notification keeps requester for scoped Chat result lookup', async () => {
  const r=runtime(), e=engine(r), w=worker(e,r);
  await e.heartbeat('test-player-instance');
  r.message('추가 https://youtu.be/dQw4w9WgXcQ'); await w.cycle();
  assert.equal(e.state.current.status,'sent_unconfirmed');
  await e.playerEvent({clientId:'test-player-instance',sessionId:e.state.current.sessionId,event:'playing'});
  assert.ok(e.state.outbox.some(x=>x.user==='users/test'));
  await w.flush(); assert.match(r.message('결과'),/재생/); assert.equal(e.state.current.observedPlaying,true);w.stop();
});
test('transient provider error is not ACKed and recovers after lease with no duplicate track', async () => {
  const r=runtime(), e=engine(r), w=worker(e,r); let fail=true;
  e.youtube.resolve=async()=>{if(fail) throw Object.assign(new Error('test'),{status:502});return {videoId:'dQw4w9WgXcQ',title:'Recovered'};};
  r.message('추가 something'); await assert.rejects(w.cycle()); assert.equal(JSON.parse(r.props.get('QUEUE')).length,1);
  fail=false; r.advance(30001); await w.cycle(); assert.equal(e.state.queue.length,1); assert.equal(JSON.parse(r.props.get('QUEUE')).length,0); w.stop();
});
test('result delivery failure defers outbox but does not block incoming commands', async () => {
  const r=runtime(), e=engine(r); let fail=true;
  const w=worker(e,r,async(_,o)=>{ const request=JSON.parse(o.body); if(request.op==='result'&&fail)throw Error('offline');return new Response(r.context.doPost({postData:{contents:o.body}}).text); });
  e.state.outbox.push({id:'earlier',space:'spaces/test',user:'users/test',text:'earlier'});
  r.message('추가 https://youtu.be/dQw4w9WgXcQ'); await w.cycle(); assert.equal(e.state.queue.length,1); assert.ok(e.state.outbox.some(x=>x.id==='earlier'));
  fail=false; r.advance(60000); await w.flush(); assert.equal(e.state.outbox.length,0); w.stop();
});
test('legacy replies without recipient are quarantined, never disclosed to another user', async () => {
  const r=runtime(), e=engine(r), w=worker(e,r); e.state.outbox.push({id:'old',space:'spaces/test',text:'old'});
  await w.flush(); assert.equal(e.state.outbox.length,0); assert.equal(e.state.deadLetters[0].failure,'BRIDGE_RECIPIENT'); w.stop();
});
test('ContentService redirect is GET without signed body; arbitrary redirects/login HTML rejected', async () => {
  const r=runtime(); let n=0;
  const w=worker(null,r,async(url,o)=>{ n++; if(n===1)return new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?test=1'}}); assert.equal(o.method,'GET'); assert.equal(o.body,undefined);return new Response('{"ok":true}'); });
  assert.equal((await w.bridge('check')).ok,true); w.stop();
  for(const target of ['https://evil.invalid/','http://script.googleusercontent.com/','https://accounts.google.com/login','https://script.googleusercontent.com:444/']) {const x=worker(null,r,async()=>new Response(null,{status:302,headers:{location:target}}));await assert.rejects(x.bridge('check'),{code:'BRIDGE_REDIRECT'});x.stop();}
  const x=worker(null,r,async()=>new Response('<html>login</html>')); await assert.rejects(x.bridge('check'),{code:'BRIDGE_FORMAT'});x.stop();
});
test('real HTTP wire roundtrip carries signed protocol into Apps Script runtime', async t => {
  const r=runtime(), server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.setHeader('Content-Type','application/json');res.end(r.context.doPost({postData:{contents:body}}).text);});
  server.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const e=engine(r), w=worker(e,r,(_,o)=>fetch(`http://127.0.0.1:${server.address().port}`,o));t.after(()=>w.stop());
  r.message('추가 https://youtu.be/dQw4w9WgXcQ');await w.cycle();assert.equal(e.state.queue.length,1);assert.match(r.message('결과'),/추가|대기열/);
});
