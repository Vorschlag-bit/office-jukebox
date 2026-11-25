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
  const e=r.event('정지'); e.message.sender.type='BOT'; assert.equal(Object.keys(r.context.onMessage(e)).length,0);
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
test('slash commands retain their verb when argumentText contains only arguments', () => {
  const r=runtime(), e=r.event('https://youtu.be/dQw4w9WgXcQ');
  e.message.text='/추가 https://youtu.be/dQw4w9WgXcQ';
  e.message.slashCommand={commandId:'1'};
  assert.match(r.context.onMessage(e).text,/접수/);
  assert.equal(r.call('pull',{clientId:randomUUID()}).command.text,'추가 https://youtu.be/dQw4w9WgXcQ');
});
test('slash setup and help return directly without enqueuing; help respects space permissions', () => {
  const r=runtime();
  assert.match(r.message('/내정보'),/spaces\/test/);
  assert.match(r.message('/info'),/spaces\/test/);
  assert.match(r.message('/result'),/아직 처리 결과/);
  assert.match(r.message('/help'),/신청하기/);
  assert.match(r.message('/도움말'),/신청하기/);
  const panel = r.context.onMessage(r.event(''));
  assert.equal(r.context.onMessage(r.event('오타')).cardsV2[0].card.header.title,'우사기 음악방');
  assert.equal(panel.cardsV2[0].card.header.title, '우사기 음악방');
  assert.equal(r.props.has('QUEUE'),false);
  assert.match(r.message('/도움말',undefined,'users/test','spaces/other'),/허용되지/);
});
test('card form accepts Apps Script inputs, deduplicates click retries and rejects forged actions/spaces', () => {
  const r=runtime();
  const event = {eventTime:new Date(r.now()).toISOString(),space:{name:'spaces/test'},user:{name:'users/test',type:'HUMAN'},message:{name:'spaces/test/messages/menu'},common:{parameters:{command:'submit-add'},formInputs:{song:{'':{stringInputs:{value:['https://youtu.be/dQw4w9WgXcQ']}}}}}};
  assert.match(r.context.onCardClick(event).text,/접수/);
  assert.match(r.context.onCardClick(event).text,/이미/);
  const command=r.call('pull',{clientId:randomUUID()}).command;
  assert.equal(command.text,'추가 https://youtu.be/dQw4w9WgXcQ');
  assert.equal(command.user,'users/test');
  assert.match(r.context.onCardClick({...event,common:{parameters:{command:'unknown'}}}).text,/지원하지/);
  assert.match(r.context.onCardClick({...event,space:{name:'spaces/other'}}).text,/허용되지/);
  assert.match(r.context.onCardClick({...event,eventTime:''}).text,/확인하지/);
});
test('stop card asks before mutation and cached status is escaped, freshness labeled, and read only', () => {
  const r=runtime(); const event=r.event('메뉴');
  const click={...event,common:{parameters:{command:'confirm-stop'}}};
  assert.match(r.context.onCardClick(click).text,/비울까요/); assert.equal(r.props.has('QUEUE'),false);
  r.call('pull',{clientId:randomUUID(),view:{current:{title:'<script>music</script>',status:'playing'},queue:[{title:'next'}],queueCount:1,paused:false,searchEnabled:false}});
  const menu=r.context.onMessage(r.event('상태'));const json=JSON.stringify(menu.cardsV2);
  assert.match(json,/&lt;script&gt;/);assert.doesNotMatch(json,/<script>/);assert.match(json,/next/);
  assert.equal(JSON.parse(r.props.get('QUEUE')||'[]').length,0);
  r.advance(31000);assert.match(JSON.stringify(r.context.onMessage(r.event('상태')).cardsV2),/연결이 잠시 끊겼/);
});
test('queue buttons cancel by stable song ID and preserve the clicking user identity', () => {
  const r=runtime(), songId=randomUUID();
  r.props.set('VIEW',JSON.stringify({at:r.now(),current:null,queue:[{id:songId,title:'A song'}],queueCount:1,paused:false,searchEnabled:false}));
  const menu=r.context.onMessage(r.event('메뉴'));assert.match(JSON.stringify(menu.cardsV2),new RegExp('취소 id:'+songId));
  const click={...r.event(''),common:{parameters:{command:'취소 id:'+songId}}};
  const reply=r.context.onCardClick(click);assert.equal(reply.actionResponse.type,'NEW_MESSAGE');assert.equal(reply.privateMessageViewer.name,'users/test');
  const command=r.call('pull',{clientId:randomUUID()}).command;
  assert.equal(command.text,'취소 id:'+songId);assert.equal(command.user,'users/test');
});
test('bounded properties survive Korean queue and result volume; TTL frees capacity', () => {
  const r=runtime();
  for(let i=0;i<50;i++) assert.match(r.message('추가 '+'가'.repeat(497),`id${i}`),/접수/);
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

test('Usagi voice decorates reception, playback, and errors exactly once without changing cards or protocol', () => {
  const r=runtime();
  const reception=r.context.onMessage(r.event('추가 https://youtu.be/dQw4w9WgXcQ'));
  assert.match(reception.text,/^(푸루|후웅)/);assert.match(reception.text,/접수/);
  assert.equal(reception.cardsV2[0].card.header.title,'우사기 음악방');
  const card=r.context.jbSpeakResponse({text:'재생 중: A song',cardsV2:[{cardId:'kept'}]});
  assert.match(card.text,/^(우라라라|야하~야핫|푸루루루)/);assert.equal(card.cardsV2[0].cardId,'kept');
  assert.equal(r.context.jbSpeakResponse(card).text,card.text);
  assert.match(r.context.onMessage(r.event('정지',undefined,'users/test','spaces/other')).text,/^(하아|후와|호와)/);
  assert.equal(r.call('check').ok,true);
});

test('playlist card submits through the same authorized durable Chat command path', async () => {
  const r=runtime(), url='https://www.youtube.com/playlist?list=PL1234567890abc';
  const menu=r.context.onMessage(r.event('메뉴'));assert.match(JSON.stringify(menu.cardsV2),/비공개 신청창 열기/);
  const click={eventTime:new Date(r.now()).toISOString(),space:{name:'spaces/test'},user:{name:'users/test',type:'HUMAN'},message:{name:'spaces/test/messages/menu'},common:{parameters:{command:'submit-playlist'},formInputs:{song:{'':{stringInputs:{value:[url]}}}}}};
  assert.match(r.context.onCardClick(click).text,/접수/s);
  assert.match(r.context.onCardClick(click).text,/이미/);
  const pulled=r.call('pull',{clientId:randomUUID()}).command;assert.equal(pulled.text,'목록 '+url);
  assert.match(r.context.onCardClick({...click,space:{name:'spaces/other'}}).text,/허용되지/);
});

test('contextual Usagi variants remain deterministic and never turn a receipt or confirmation into playback', () => {
  const r=runtime(), results=new Set();
  for(let i=0;i<12;i++) results.add(r.context.jbSpeakResponse({text:'접수했습니다. 보통 5~10초 안에 처리해요. 아래 결과 확인 버튼으로 진행 상황을 볼 수 있어요.'},'event-'+i).text.split('\n')[0]);
  assert.equal(results.size,3);
  const text='재생을 멈추고 대기열을 모두 비울까요?';
  assert.equal(r.context.jbSpeakResponse({text},'a').text,r.context.jbSpeakResponse({text},'a').text);
  assert.match(r.context.jbSpeakResponse({text},'a').text,/비울까|확인/);
  assert.doesNotMatch(r.context.jbSpeakResponse({text},'a').text,/정리했어|재생 중/);
  assert.match(r.context.jbSpeakResponse({text:'유효한 HTTPS 유튜브 영상 URL만 신청할 수 있습니다.'},'bad-url').text,/^(하아|후와|호와)/);
  const error=r.context.jbSpeakResponse({text:'재생 오류: 노래 [YOUTUBE_150]'},'b');assert.match(error.text,/YOUTUBE_150/);
  const receipt=r.context.jbSpeakResponse({text:'접수했습니다. 보통 5~10초 안에 처리해요. 아래 결과 확인 버튼으로 진행 상황을 볼 수 있어요.'},'c');assert.match(receipt.text,/아직 재생 확인은 아니야/);
  const web=vm.createContext({});vm.runInContext(readFileSync(new URL('../public/voice.js',import.meta.url),'utf8'),web);
  for(const text of ['재생 중: 노래','일시정지를 요청했습니다.','신청 취소: 노래','재생 오류: <test> [YOUTUBE_150]']) assert.equal(web.UsagiVoice.say(text,'same'),r.context.jbSpeakResponse({text},'same').text);
});

function dialogEvent(r, command, overrides={}) {
  return {...r.event(''),dialogEventType:'REQUEST_DIALOG',common:{parameters:{command}},...overrides};
}
test('private request dialog does not post a public receipt, duplicates once, and keeps permission checks', () => {
  const r=runtime();
  const open=r.context.onCardClick(dialogEvent(r,'open-anonymous'));
  assert.equal(open.actionResponse.type,'DIALOG');assert.match(JSON.stringify(open),/privateSong/);assert.equal(r.props.has('QUEUE'),false);
  const input=dialogEvent(r,'anonymous-add',{dialogEventType:'SUBMIT_DIALOG',common:{parameters:{command:'anonymous-add',user:'users/forged'},formInputs:{privateSong:{stringInputs:{value:['https://youtu.be/dQw4w9WgXcQ']}}}}});
  const reply=r.context.onCardClick(input);
  assert.equal(reply.actionResponse.type,'DIALOG');assert.equal(reply.actionResponse.dialogAction.actionStatus.statusCode,'OK');
  assert.equal(reply.text,undefined);assert.equal(reply.cardsV2,undefined);assert.doesNotMatch(JSON.stringify(reply),/dQw4w9WgXcQ|users\/test/);
  r.context.onCardClick(input);
  const request=r.call('pull',{clientId:randomUUID()}).command;assert.equal(request.text,'추가 https://youtu.be/dQw4w9WgXcQ');assert.equal(request.user,'users/test');
  assert.equal(JSON.parse(r.props.get('QUEUE')).length,1);
  const denied=r.context.onCardClick({...input,space:{name:'spaces/other'}});assert.match(denied.text,/허용되지/);assert.equal(denied.privateMessageViewer.name,'users/test');
});
test('private dialog validates context, empty input and cancellation without enqueueing', () => {
  const r=runtime();
  const empty=r.context.onCardClick(dialogEvent(r,'anonymous-add',{dialogEventType:'SUBMIT_DIALOG'}));assert.equal(empty.actionResponse.dialogAction.actionStatus.statusCode,'INVALID_ARGUMENT');
  assert.match(r.context.onCardClick(dialogEvent(r,'open-anonymous',{dialogEventType:undefined})).text,/새 메뉴/);
  const cancel=r.context.onCardClick(dialogEvent(r,'anonymous-add',{dialogEventType:'CANCEL_DIALOG'}));assert.equal(cancel.actionResponse.dialogAction.actionStatus.statusCode,'OK');
  assert.equal(r.props.has('QUEUE'),false);
});
test('launch cards, playlist replies and dialogs are private to the requesting user', () => {
  const r=runtime();
  r.props.set('r_'+r.context.jbHash('spaces/test/users/test'),JSON.stringify({at:r.now(),text:'MY_PRIVATE_RESULT'}));
  r.props.set('r_'+r.context.jbHash('spaces/test/users/other'),JSON.stringify({at:r.now(),text:'OTHER_PRIVATE_RESULT'}));
  const launch=r.context.onMessage(r.event('익명메뉴'));assert.equal(launch.privateMessageViewer.name,'users/test');assert.match(JSON.stringify(launch),/OPEN_DIALOG/);
  const result=r.context.onCardClick(dialogEvent(r,'open-private-result'));assert.equal(result.actionResponse.type,'DIALOG');assert.match(JSON.stringify(result),/MY_PRIVATE_RESULT/);assert.doesNotMatch(JSON.stringify(result),/OTHER_PRIVATE_RESULT/);
  assert.equal(r.context.onMessage(r.event('전체플리')).privateMessageViewer.name, 'users/test');
  assert.equal(Object.keys(r.context.onAddedToSpace()).length, 0);
  const privateReply=r.context.onMessage(r.event('결과'));assert.equal(privateReply.privateMessageViewer.name,'users/test');
  const privateCard=r.context.onCardClick(dialogEvent(r,'메뉴',{dialogEventType:undefined}));assert.equal(privateCard.actionResponse.type,'NEW_MESSAGE');assert.equal(privateCard.privateMessageViewer.name,'users/test');
});

test('full queue pages preserve every ordered song, hide identities, bound properties and refresh changed pages', async () => {
  const r=runtime(), e=engine(r), w=worker(e,r);
  e.state.queue=Array.from({length:500},(_,i)=>({id:randomUUID(),title:`${i} <tag> `+'🐰'.repeat(90),videoId:'dQw4w9WgXcQ',requestedBy:'users/private',requestSpace:'spaces/private'}));
  await w.cycle();
  let all=[];
  for(let page=0;page<50;page++) {
    const reply=r.context.onCardClick({...r.event(''),dialogEventType:'SUBMIT_DIALOG',common:{parameters:{command:`queue-dialog:${page}`}}});
    assert.equal(reply.actionResponse.type,'DIALOG');
    assert.equal(reply.privateMessageViewer,undefined);
    const json=JSON.stringify(reply);assert.doesNotMatch(json,/users\/private|spaces\/private|<tag>/);assert.match(json,/&lt;tag&gt;/);
    all.push(...reply.actionResponse.dialogAction.dialog.body.sections[0].widgets.slice(1,-1).map(x=>x.textParagraph.text));
  }
  assert.equal(all.length,500);all.forEach((row,i)=>assert.ok(row.startsWith(`${i+1}. ${i} `)));
  const oldRevision=JSON.parse(r.props.get('QUEUE_VIEW')).revision;
  assert.equal(JSON.parse(r.props.get('VIEW')).queue.length,8);
  e.state.queue=e.state.queue.slice(0,3);await w.cycle();assert.equal(r.props.has('QV_49'),false);
  const refreshed=r.context.onCardClick({...r.event(''),dialogEventType:'SUBMIT_DIALOG',common:{parameters:{command:`queue-dialog:49:${oldRevision}`}}});assert.match(JSON.stringify(refreshed),/첫 페이지/);
  r.advance(31000);assert.match(JSON.stringify(r.context.onMessage(r.event('플리'))),/마지막으로/);
  const denied=r.context.onCardClick({...r.event('',undefined,'users/test','spaces/other'),common:{parameters:{command:'queue-open'}}});assert.match(denied.text,/허용되지/);
  e.state.queue=[];await w.cycle();assert.match(JSON.stringify(r.context.onMessage(r.event('전체플리'))),/대기곡이 없어/);
});
test('queue revision acknowledgement resends after bridge reset and malformed full views cannot replace cached list', async () => {
  const r=runtime(),e=engine(r),w=worker(e,r);await w.cycle();const revision=JSON.parse(r.props.get('QUEUE_VIEW')).revision;
  r.props.delete('QUEUE_VIEW');await w.cycle();assert.equal(w.queueRevision,null);await w.cycle();assert.equal(JSON.parse(r.props.get('QUEUE_VIEW')).revision,revision);
  const bad=r.call('pull',{clientId:w.clientId,view:{queueCount:1},queueView:{revision:'a'.repeat(64),songs:[{id:randomUUID(),title:'x'.repeat(81)}]}});assert.equal(bad.ok,false);assert.equal(JSON.parse(r.props.get('QUEUE_VIEW')).revision,revision);
});

test('private search dialog returns selectable results only to their owner and enqueues chosen song once', async () => {
  const r=runtime(),e=engine(r),w=worker(e,r);e.youtube.key='test-only';e.youtube.search=async()=>[{videoId:'dQw4w9WgXcQ',title:'first',source:'search'},{videoId:'s7gef3SXSbY',title:'second',source:'search'}];await w.cycle();
  const open=r.context.onCardClick(dialogEvent(r,'open-anonymous'));assert.match(JSON.stringify(open),/곡명 검색|검색할 곡명/);
  const input=dialogEvent(r,'anonymous-search',{dialogEventType:'SUBMIT_DIALOG',common:{parameters:{command:'anonymous-search'},formInputs:{privateSong:{stringInputs:{value:['my song']}}}}});
  assert.equal(r.context.onCardClick(input).actionResponse.dialogAction.actionStatus.statusCode,'OK');await w.cycle();
  const result=r.context.onCardClick(dialogEvent(r,'open-private-result'));const pickCommand=JSON.stringify(result).match(/anonymous-pick:[a-f0-9-]{36}:2/)[0];assert.equal(result.text,undefined);
  const other=dialogEvent(r,'open-private-result');other.user={name:'users/other',type:'HUMAN'};assert.doesNotMatch(JSON.stringify(r.context.onCardClick(other)),/anonymous-pick|second/);
  const pick=dialogEvent(r,pickCommand,{dialogEventType:'SUBMIT_DIALOG'});assert.equal(r.context.onCardClick(pick).actionResponse.dialogAction.actionStatus.statusCode,'OK');r.context.onCardClick(pick);await w.cycle();assert.equal(e.state.queue.length,1);assert.equal(e.state.queue[0].videoId,'s7gef3SXSbY');
});
test('private search remains unavailable without configured key and expired results have no selection buttons', async () => {
  const r=runtime(),w=worker(engine(r),r);await w.cycle();const input=dialogEvent(r,'anonymous-search',{dialogEventType:'SUBMIT_DIALOG',common:{parameters:{command:'anonymous-search'},formInputs:{privateSong:{stringInputs:{value:['song']}}}}});assert.equal(r.context.onCardClick(input).actionResponse.dialogAction.actionStatus.statusCode,'INVALID_ARGUMENT');assert.equal(JSON.parse(r.props.get('QUEUE') || '[]').length,0);
  r.props.set('r_'+r.context.jbHash('spaces/test/users/test'),JSON.stringify({at:r.now()-300001,text:'1. old\n5분 이내에 선택 <번호>를 보내세요.'}));assert.doesNotMatch(JSON.stringify(r.context.onCardClick(dialogEvent(r,'open-private-result'))),/anonymous-pick/);
});

test('Chat menus expose only validated local web links without privileged tokens or HTTPS-upgrading buttons',async()=>{const r=runtime(),e=engine(r),w=new AppsScriptWorker({config:config(),engine:e,now:r.now,publicUrl:'http://jukebox-test.local:8787/queue',fetcher:async(_,options)=>new Response(r.context.doPost({postData:{contents:options.body}}).text,{headers:{'Content-Type':'application/json'}}),log:()=>{}});await w.cycle();const reply=r.context.onMessage(r.event('웹'));assert.match(reply.text,/http:\/\/jukebox-test\.local:8787\/queue/);assert.equal(reply.privateMessageViewer.name,'users/test');assert.match(JSON.stringify(reply.cardsV2),/웹 음악방 열기/);assert.doesNotMatch(JSON.stringify(reply),/"openLink"|<a href=|adminToken|playerToken|test-only-not-a-live-secret/);for(const url of ['javascript:alert(1)','http://evil.example/queue','http://good.local:0/queue','http://good.local:8787/queue?adminToken=x'])assert.equal(r.context.jbWebUrl(url),null);});

test('opt-in Chat member controls allow next/stop/pause/resume without granting operator or cross-space access',async()=>{
 const r=runtime(),e=engine(r);let stops=0;e.adapter.stop=async()=>{stops++};const w=new AppsScriptWorker({config:{...config(),memberPlaybackControls:true},engine:e,now:r.now,fetcher:async(_,o)=>new Response(r.context.doPost({postData:{contents:o.body}}).text,{headers:{'Content-Type':'application/json'}}),log:()=>{}});
 r.message('일시정지');await w.cycle();assert.equal(e.state.paused,true);r.message('계속');await w.cycle();assert.equal(e.state.paused,false);
 r.message('추가 https://youtu.be/dQw4w9WgXcQ');await w.cycle();assert.equal(e.state.queue.length,1);r.message('다음');await w.cycle();assert.equal(stops,1);
 r.message('재시도');await w.cycle();assert.match(r.message('결과'),/운영자/);assert.equal(stops,1);r.message('확인');await w.cycle();assert.match(r.message('결과'),/운영자/);
 e.state.queue[0].requestedBy='users/other';r.message('취소 1');await w.cycle();assert.match(r.message('결과'),/본인의/);assert.equal(e.state.queue.length,1);
 assert.match(JSON.stringify(r.context.onMessage(r.event('메뉴')).cardsV2),/재생 제어 · 모든 참여자/);
 r.message('정지',undefined,'users/test','spaces/other');await w.cycle();assert.equal(stops,1);assert.equal(e.state.queue.length,1);
 e.state.manualReturn={id:'manual',videoId:'aaaaaaaaaaa',title:'manual',source:'external_tv',resumePositionSeconds:0,expiresAt:r.now()+10000};r.message('정지');await w.cycle();assert.equal(stops,2);assert.equal(e.state.queue.length,0);assert.equal(e.state.manualReturn,null);w.stop();
 await assert.rejects(e.command({text:'정지',user:'web-visitor'}),{code:'FORBIDDEN'});
});

test('new Chat search keeps same dialog, isolates users and rejects stale search picks', async () => {
  const r = runtime(), e = engine(r), w = worker(e, r);
  e.youtube.key = 'test-only';
  e.youtube.search = async phrase => [{ videoId: phrase === 'old' ? 'dQw4w9WgXcQ' : 's7gef3SXSbY', title: phrase, source: 'search' }];
  await w.cycle();
  const submit = query => r.context.onCardClick(dialogEvent(r, 'search-submit', {
    dialogEventType: 'SUBMIT_DIALOG',
    common: { parameters: { command: 'search-submit' }, formInputs: { searchSong: { stringInputs: { value: [query] } } } }
  }));
  const click = (command, user = 'users/test') => r.context.onCardClick(dialogEvent(r, command, { dialogEventType: 'SUBMIT_DIALOG', user: { name: user, type: 'HUMAN' } }));
  const oldCheck = JSON.stringify(submit('old')).match(/search-check:[a-f0-9]{64}/)[0];
  assert.doesNotMatch(JSON.stringify(click(oldCheck, 'users/other')), /search-pick|곡을 찾는/);
  await w.cycle();
  const oldPick = JSON.stringify(click(oldCheck)).match(/search-pick:[a-f0-9]{64}:1/)[0];
  const newCheck = JSON.stringify(submit('new')).match(/search-check:[a-f0-9]{64}/)[0];
  await w.cycle();
  click(oldPick);
  await w.cycle();
  assert.equal(e.state.queue.length, 0);
  const newPick = JSON.stringify(click(newCheck)).match(/search-pick:[a-f0-9]{64}:1/)[0];
  assert.match(JSON.stringify(click(newPick)), /접수했어/);
  click(newPick);
  await w.cycle();
  assert.deepEqual(e.state.queue.map(song => song.videoId), ['s7gef3SXSbY']);
});

test('feature feedback is stored once and exposed privately only to configured operators', async () => {
  const r = runtime(), w = worker(engine(r), r);
  await w.cycle();
  const submit = dialogEvent(r, 'feedback-submit', { dialogEventType: 'SUBMIT_DIALOG',
    common: { parameters: { command: 'feedback-submit' }, formInputs: { feedbackText: { stringInputs: { value: ['<기능> 제안'] } } } } });
  assert.match(JSON.stringify(r.context.onCardClick(submit)), /요청함에 남겼어/);
  r.context.onCardClick(submit);
  assert.equal(JSON.parse(r.props.get('FEEDBACK')).length, 1);
  assert.doesNotMatch(JSON.stringify(r.context.onMessage(r.event('기능요청함'))), /제안/);
  const inbox = r.context.onMessage(r.event('기능요청함', undefined, 'users/operator'));
  assert.equal(inbox.privateMessageViewer.name, 'users/operator');
  assert.match(JSON.stringify(inbox), /&lt;기능&gt; 제안/);
  assert.equal(r.props.has('QUEUE'), false);
});

test('old result cards cannot submit a number from a newer search', async () => {
  const r = runtime(), e = engine(r), w = worker(e, r);
  e.youtube.key = 'test-only';
  e.youtube.search = async title => [{ videoId: 'dQw4w9WgXcQ', title, source: 'search' }];
  const cardPick = command => r.context.onCardClick({ ...r.event(''), common: { parameters: { command } } });
  r.message('검색 first');
  await w.cycle();
  const old = JSON.stringify(r.context.onMessage(r.event('결과'))).match(/result-pick:[a-f0-9-]{36}:1/)[0];
  r.message('검색 second');
  await w.cycle();
  assert.match(cardPick(old).text, /만료/);
  assert.match(cardPick('선택 1').text, /이전 검색/);
  await w.cycle();
  assert.equal(e.state.queue.length, 0);
  const current = JSON.stringify(r.context.onMessage(r.event('결과'))).match(/result-pick:[a-f0-9-]{36}:1/)[0];
  assert.match(cardPick(current).text, /접수/);
  await w.cycle();
  assert.equal(e.state.queue[0].title, 'second');
});
