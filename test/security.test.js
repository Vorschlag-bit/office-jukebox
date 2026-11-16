import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createServer} from '../src/server.js';
import {secureControlTransport,validHost} from '../src/security.js';
import {MemoryStore} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {BrowserAdapter} from '../src/adapters.js';
import {GoogleWorker} from '../src/google.js';
function certificate() {
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});
  function der(tag,value){const b=Buffer.from(value);let n=b.length,len;if(n<128)len=Buffer.from([n]);else{const bytes=[];while(n){bytes.unshift(n&255);n>>>=8;}len=Buffer.from([128|bytes.length,...bytes]);}return Buffer.concat([Buffer.from([tag]),len,b]);}
  const seq=(...parts)=>der(48,Buffer.concat(parts)),algorithm=seq(Buffer.from('06092a864886f70d01010b0500','hex'));
  const name=seq(der(49,seq(Buffer.from('0603550403','hex'),der(12,Buffer.from('localhost')))));
  const validity=seq(der(23,Buffer.from('250101000000Z')),der(23,Buffer.from('350101000000Z')));
  const tbs=seq(der(160,der(2,[2])),der(2,[1]),algorithm,name,validity,name,pair.publicKey.export({format:'der',type:'spki'}));
  const bytes=seq(tbs,algorithm,der(3,Buffer.concat([Buffer.from([0]),sign('RSA-SHA256',tbs,pair.privateKey)])));
  return {key:pair.privateKey.export({format:'pem',type:'pkcs8'}),cert:`-----BEGIN CERTIFICATE-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`};
}
function engine(){return new Engine({store:new MemoryStore(),youtube:{},adapter:new BrowserAdapter()});}
async function serve(t,tls){const e=engine(),config={adminToken:'admin-test-'.repeat(5),playerToken:'player-test-'.repeat(5),lan:{enabled:true}},s=createServer({engine:e,config,tls});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.close(r);s.closeAllConnections();}));return {s,e,config,port:s.address().port};}
function request(port,ca,path,headers={},body,servername='localhost'){return new Promise((resolve,reject)=>{const r=https.request({hostname:'127.0.0.1',servername,port,path,ca,method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},timeout:3000},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)}));});r.on('error',reject);r.on('timeout',()=>r.destroy(Error('test timeout')));r.end(body===undefined?undefined:JSON.stringify(body));});}
test('control keys require genuine TLS or loopback; forwarded transport and private IPs do not qualify',()=>{
  for(const address of ['10.0.0.2','172.30.1.2','192.168.1.2','203.0.113.2'])assert.equal(secureControlTransport({socket:{remoteAddress:address},headers:{'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'}}),false);
  for(const address of ['127.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(secureControlTransport({socket:{remoteAddress:address},headers:{}}),true);
  assert.equal(secureControlTransport({socket:{remoteAddress:'10.0.0.2',encrypted:true},headers:{}}),true);
  assert.equal(validHost({headers:{host:'evil.example:8787'},socket:{remoteAddress:'127.0.0.1',localAddress:'127.0.0.1',localPort:8787}}),false);
});
test('real HTTPS validates server identity, enforces token roles and keeps cross-origin control blocked',async t=>{
  const cert=certificate(),{port,config,s}=await serve(t,cert);
  await assert.rejects(request(port,undefined,'/api/state'),e=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code));
  await assert.rejects(request(port,cert.cert,'/api/state',{},undefined,'wrong.example'),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
  assert.equal((await request(port,cert.cert,'/api/state')).status,401);
  assert.equal((await request(port,cert.cert,'/api/state',{Authorization:'Bearer '+config.playerToken})).status,401);
  const state=await request(port,cert.cert,'/api/state',{Authorization:'Bearer '+config.adminToken});assert.equal(state.status,200);assert.equal(state.headers['cache-control'],'no-store');assert.equal(state.headers['x-frame-options'],'DENY');assert.match(state.headers['content-security-policy'],/form-action 'self'/);
  assert.equal((await request(port,cert.cert,'/api/command',{Authorization:'Bearer '+config.adminToken,Origin:'https://evil.example'},{text:'정지'})).status,403);
  assert.equal((await request(port,cert.cert,'/api/command',{Authorization:'Bearer '+config.adminToken,Origin:`https://127.0.0.1:${port}`},{text:'대기열'})).status,200);
  assert.ok(s.requestTimeout<=15000);assert.ok(s.headersTimeout<=10000);assert.equal(s.maxConnections,128);
});
test('forged Host is rejected even with LAN disabled, and oversized headers fail before credentials',async t=>{
  const e=engine(),s=createServer({engine:e,config:{adminToken:'a'.repeat(40),playerToken:'p'.repeat(40)}});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.close(r);s.closeAllConnections();}));
  const req=headers=>new Promise((resolve,reject)=>{const r=http.get({hostname:'127.0.0.1',port:s.address().port,path:'/api/state',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.on('error',reject);});
  assert.equal(await req({Host:`evil.example:${s.address().port}`,Authorization:'Bearer '+'a'.repeat(40)}),403);
  assert.equal(await req({'X-Large':'x'.repeat(10000)}),431);
});
function invalidEvent(){return {message:{data:Buffer.from(JSON.stringify({type:'MESSAGE',eventTime:new Date().toISOString(),space:{name:'spaces/test'},user:{name:'users/test'},message:{name:'spaces/test/messages/new-error',argumentText:'취소 invalid',sender:{name:'users/test',type:'HUMAN'}}})).toString('base64')}};}
test('Chat invalid-command dedup remains bounded and full error outbox cannot grow or lose retries',async()=>{
  const e=engine();for(let i=0;i<5010;i++)e.state.seen['old-'+i]={reply:'old',at:0};const w=new GoogleWorker({config:{allowedSpaces:['spaces/test'],operatorUsers:[]},engine:e,log:()=>{}});await w.receive(invalidEvent());assert.equal(Object.keys(e.state.seen).length,5000);assert.equal(e.state.outbox.length,1);
  e.state.seen={};e.state.outbox=Array.from({length:500},(_,i)=>({id:String(i),text:'pending',space:'spaces/test'}));await assert.rejects(w.receive(invalidEvent()),{code:'NOTIFICATIONS_FULL'});assert.equal(e.state.outbox.length,500);assert.equal(Object.hasOwn(e.state.seen,'spaces/test/messages/new-error'),false);
});

test('known vulnerable runtime patch levels fail closed before starting a server', async()=>{
  const {assertRuntimeVersion}=await import('../src/security.js');for(const v of ['24.22.2','24.1.0','26.8.1','26.13.0','22.23.5'])assert.throws(()=>assertRuntimeVersion(v),{code:'NODE_SECURITY'});for(const v of ['24.22.3','24.23.0','26.13.1','26.14.0'])assert.doesNotThrow(()=>assertRuntimeVersion(v));
});

test('cached administrator page on remote HTTP clears credentials without sending a request',async()=>{
  const vm=await import('node:vm'),{readFileSync}=await import('node:fs');const elements=new Map(),storage=new Map([['jukebox-admin','previous-test-token']]);let requests=0;
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false});return elements.get(id);};
  const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[]},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{location:{protocol:'http:',hostname:'192.0.2.10',origin:'http://192.0.2.10'},addEventListener(){}},fetch:()=>{requests++;throw Error('must not transmit');},Promise,Error,clearInterval(){},setInterval(){},UsagiVoice:{say:x=>x}});
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),context);assert.equal(storage.has('jukebox-admin'),false);assert.equal(requests,0);
  element('token').value='new-test-token';context.connect();await new Promise(r=>setImmediate(r));assert.equal(requests,0);assert.equal(element('token').value,'');assert.equal(context.token,'');
  storage.set('jukebox-admin','session-test-token');element('disconnect').onclick();assert.equal(storage.has('jukebox-admin'),false);assert.equal(element('dashboard').hidden,true);
});
