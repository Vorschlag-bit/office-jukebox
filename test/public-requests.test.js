import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import{randomBytes}from'node:crypto';import{createServer}from'../src/server.js';import{Engine}from'../src/engine.js';import{MemoryStore}from'../src/store.js';import{BrowserAdapter}from'../src/adapters.js';
const video='https://youtu.be/dQw4w9WgXcQ';
async function fixture(t,enabled=true,store=new MemoryStore()){
  const youtube={key:'test-api-key',search:async()=>[{videoId:'dQw4w9WgXcQ',title:'one',source:'search'},{videoId:'s7gef3SXSbY',title:'two',source:'search'}],resolve:async()=>({videoId:'dQw4w9WgXcQ',title:'link',source:'url'}),playlist:async()=>[{videoId:'dQw4w9WgXcQ',title:'list',source:'playlist'}]};
  const engine=new Engine({store,youtube,adapter:new BrowserAdapter(),perUserLimit:2});const config={adminToken:'a'.repeat(40),playerToken:'p'.repeat(40),port:8787,lan:{enabled:true,hostnames:['jukebox-test.local'],requests:{enabled,secret:'separate-test-web-secret'.repeat(2)}}};const server=createServer({engine,config});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const port=server.address().port,origin='http://jukebox-test.local:'+port;
  const req=(path,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:'jukebox-test.local:'+port,...headers}},response=>{let text='';response.on('data',x=>text+=x);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,data:JSON.parse(text)}));});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});
  const session=async(cookie)=>{const r=await req('/api/public/session',{headers:cookie?{Cookie:cookie}:{}});return{cookie:r.headers['set-cookie']?.[0].split(';')[0],csrf:r.data.csrfToken,response:r};};
  const post=(s,body,headers={})=>req('/api/public/request',{method:'POST',body:{requestId:randomBytes(16).toString('hex'),...body},headers:{Origin:origin,Cookie:s.cookie,'X-Jukebox-CSRF':s.csrf,'Content-Type':'application/json',...headers}});return{engine,config,req,session,post,origin};
}
test('LAN web request opt-in keeps read-only queue and privileged APIs protected',async t=>{const f=await fixture(t,false);assert.equal((await f.req('/api/public/queue')).data.requestsEnabled,false);assert.notEqual((await f.req('/api/public/session')).status,200);const g=await fixture(t),s=await g.session();assert.match(s.response.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);assert.equal((await g.req('/api/state',{headers:{Cookie:s.cookie,'X-Jukebox-CSRF':s.csrf}})).status,403);assert.equal((await g.post(s,{action:'stop'})).status,400);assert.equal(g.engine.state.queue.length,0);});
test('web links, search and choice are isolated, idempotent, unprivileged and bounded per visitor',async t=>{const f=await fixture(t),s=await f.session(),other=await f.session();const result=await f.post(s,{action:'search',query:'song'});assert.equal(result.status,200);assert.equal(result.data.choices.length,2);assert.equal(f.engine.state.queue.length,0);assert.equal((await f.post(other,{action:'select',index:1,selectionId:result.data.selectionId})).data.error,'CHOICE_EXPIRED');const id=randomBytes(16).toString('hex'),choice={action:'select',index:2,selectionId:result.data.selectionId,requestId:id};assert.equal((await f.post(s,choice)).status,200);assert.equal((await f.post(s,choice)).status,200);assert.equal(f.engine.state.queue.length,1);assert.equal(f.engine.state.queue[0].videoId,'s7gef3SXSbY');assert.equal((await f.post(s,{action:'add',query:video})).status,200);assert.equal((await f.post(s,{action:'add',query:video})).data.error,'USER_LIMIT');assert.equal(f.engine.state.current,null);const shared=(await f.req('/api/public/queue')).data;assert.doesNotMatch(JSON.stringify(shared),/requestedBy|csrf|separate-test-web-secret|cookie|web-/);});
test('public writes reject missing CSRF, forged origins, malformed links and old search selections',async t=>{const f=await fixture(t),s=await f.session();assert.equal((await f.post(s,{action:'add',query:video},{'X-Jukebox-CSRF':''})).status,401);assert.equal((await f.post(s,{action:'add',query:video},{Origin:'http://evil.example'})).status,403);assert.equal((await f.req('/api/public/session',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);assert.equal((await f.post(s,{action:'add',query:'https://evil.example/video'})).status,400);const old=(await f.post(s,{action:'search',query:'first'})).data;await f.post(s,{action:'search',query:'second'});assert.equal((await f.post(s,{action:'select',index:1,selectionId:old.selectionId})).data.error,'CHOICE_EXPIRED');assert.equal(f.engine.state.queue.length,0);});
test('stable signed visitor identity preserves deduplication and limits across HTTP listener replacement',async t=>{const store=new MemoryStore(),f=await fixture(t,true,store),s=await f.session(),body={action:'add',query:video,requestId:randomBytes(16).toString('hex')};assert.equal((await f.post(s,body)).status,200);const g=await fixture(t,true,store);assert.equal((await g.post(s,body)).status,401);const again=await g.session(s.cookie);assert.equal(again.cookie,s.cookie);assert.equal((await g.post(again,body)).status,200);assert.equal(g.engine.state.queue.length,1);assert.equal((await g.post(again,{action:'add',query:video})).status,200);assert.equal((await g.post(again,{action:'add',query:video})).data.error,'USER_LIMIT');});
test('repeated public writes hit an independent per-IP quota even when command validation fails',async t=>{const f=await fixture(t),s=await f.session();for(let i=0;i<8;i++)assert.equal((await f.post(s,{action:'add',query:'bad link'})).status,400);assert.equal((await f.post(s,{action:'add',query:video})).status,429);});

test('web search returns while playback is busy and several candidates can be requested once each', async t => {
  const f = await fixture(t);
  const visitor = await f.session();
  const { promise, resolve } = Promise.withResolvers();
  const playback = f.engine.serial(() => promise);
  try {
    f.engine.youtube.search = async (_, embedded, limit) => {
      assert.equal(embedded, true);
      assert.equal(limit, 10);
      return Array.from({ length: 10 }, (_, index) => ({
        videoId: 'aaaaaaaaaa' + index,
        title: 'Song ' + index,
        channelTitle: 'Test channel'
      }));
    };
    const result = await f.post(visitor, { action: 'search', query: 'song' });
    assert.equal(result.status, 200);
    assert.equal(result.data.choices.length, 10);
    assert.equal(result.data.choices[9].channelTitle, 'Test channel');
    assert.equal(f.engine.state.queue.length, 0);
    resolve();
    const choice = { action: 'select', index: 10, selectionId: result.data.selectionId };
    for (const index of [10, 10, 1]) {
      assert.equal((await f.post(visitor, { ...choice, index })).status, 200);
    }
    assert.deepEqual(f.engine.state.queue.map(song => song.videoId), ['aaaaaaaaaa9', 'aaaaaaaaaa0']);
  } finally {
    resolve();
    await playback;
  }
});
