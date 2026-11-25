import test from 'node:test';
import assert from 'node:assert/strict';
import { LoungeFrames, LoungeClient, LoungeAdapter, pairTvCode } from '../src/lounge.js';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';

function framed(events) { const bytes = Buffer.from(JSON.stringify(events)); return Buffer.concat([Buffer.from(`${bytes.length}\n`), bytes]); }
const response = text => new Response(text, { status: 200 });
test('Lounge parses UTF-8 length-prefixed events across every byte boundary', () => {
  const events = []; const parser = new LoungeFrames(x => events.push(x));
  const data = framed([[1, ['nowPlaying', { title: '한글 🎵', videoId: 'dQw4w9WgXcQ' }]], [2, ['noop']]]);
  for (const b of data) parser.push(Buffer.from([b]));
  assert.equal(events.length, 2); assert.equal(events[0].args[0].title, '한글 🎵');
});
test('Lounge handles adjacent chunks and incomplete chunk without inventing events', () => {
  const events = [], parser = new LoungeFrames(x => events.push(x));
  const a = framed([[1, ['c', 'session']]]), b = framed([[2, ['S', 'google-session']]]);
  parser.push(Buffer.concat([a, b.subarray(0, b.length - 1)])); assert.equal(events.length, 1);
  parser.push(b.subarray(b.length - 1)); assert.equal(events.length, 2);
});
for (const bad of ['99999999\n', 'x\n', '-1\n', '2\n{}', '4\nnope']) test(`Lounge rejects malformed or oversized framing: ${bad.trim()}`, () => {
  assert.throws(() => new LoungeFrames(() => {}).push(Buffer.from(bad)));
});
test('TV code pairing uses fixed HTTPS endpoint, never browser cookies or arbitrary URLs', async () => {
  const paired = await pairTvCode('1234-5678 9012', { fetcher: async (url, options) => {
    assert.equal(url, 'https://www.youtube.com/api/lounge/pairing/get_screen'); assert.equal(options.method, 'POST');
    assert.equal(new URLSearchParams(options.body).get('pairing_code'), '123456789012'); assert.equal(options.headers.Cookie, undefined);
    return response(JSON.stringify({ screen: { screenId: 'screen-test', loungeToken: 'token-test', name: 'Test TV' } }));
  } });
  assert.equal(paired.screenId, 'screen-test');
});
test('expired and login activation codes rejected without guessing more codes', async () => {
  let calls = 0; const fetcher = async () => { calls++; return response('{}'); };
  await assert.rejects(pairTvCode('ABCD-EFGH', { fetcher }), { code: 'TV_CODE' }); assert.equal(calls, 0);
  await assert.rejects(pairTvCode('123456789012', { fetcher }), { code: 'TV_CODE' }); assert.equal(calls, 1);
});
function clientFixture({ failCommand = false } = {}) {
  const calls = []; let saved;
  const client = new LoungeClient({ screenId: 'test-screen', loungeToken: 'old-token', remoteId: 'test-remote' }, {
    savePairing: value => { saved = value; },
    fetcher: async (url, opts) => {
      calls.push({ url, form: new URLSearchParams(opts.body) });
      if (url.includes('get_lounge_token_batch')) return response(JSON.stringify({ screens: [{ screenId: 'test-screen', loungeToken: 'fresh-token' }] }));
      if (new URLSearchParams(opts.body).has('req0__sc')) { if (failCommand) throw new Error('ambiguous network timeout'); return response(''); }
      return response(framed([[0, ['c', 'sid-test']], [1, ['S', 'gsid-test']]]));
    }
  });
  return { client, calls, saved: () => saved };
}
test('Lounge refreshes token, single-flights concurrent connection, sequences offsets', async () => {
  const { client, calls, saved } = clientFixture(); await Promise.all([client.connect(), client.connect(), client.connect()]);
  assert.equal(calls.length, 2); assert.equal(saved().loungeToken, 'fresh-token');
  const result = await client.command('setPlaylist', { videoId: 'dQw4w9WgXcQ' }); await client.command('pause');
  assert.equal(result.confirmed, false); assert.equal(calls[2].form.get('ofs'), '1'); assert.equal(calls[3].form.get('ofs'), '2');
  assert.equal(new URL(calls[2].url).searchParams.get('loungeIdToken'), 'fresh-token');
});
test('Lounge command with uncertain network failure is not automatically replayed', async () => {
  const { client, calls } = clientFixture({ failCommand: true }); await assert.rejects(client.command('setPlaylist', { videoId: 'dQw4w9WgXcQ' }), { code: 'LOUNGE_NETWORK' });
  assert.equal(calls.filter(x => x.form.has('req0__sc')).length, 1);
  assert.equal(client.sid, null);
});
test('Lounge AID replay is ignored', () => {
  const seen = []; const client = new LoungeClient({}, { onEvent: x => seen.push(x.id) });
  client.consume({ id: 5, name: 'noop', args: [] }); client.consume({ id: 5, name: 'noop', args: [] }); client.consume({ id: 3, name: 'noop', args: [] }); assert.deepEqual(seen, [5]);
});
function adapterFixture(t) {
  const calls = [], events = [];
  const client = { aid: 10, epoch: 1, connect: async () => {}, command: async (name, params) => { calls.push({ name, params }); return { confirmed: false }; }, poll: async signal => new Promise((resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) };
  const adapter = new LoungeAdapter({ experimental: true }, { client }); adapter.setListener(e => events.push(e)); t.after(() => adapter.close());
  const send = (id, name, payload) => adapter.handle({ id, name, args: [payload] });
  return { adapter, calls, events, send };
}
const track = { sessionId: 'session-a', videoId: 'dQw4w9WgXcQ' };
test('native TV playback confirms only requested video + nonce + playing state', async t => {
  const { adapter, events, send } = adapterFixture(t); await adapter.play(track); assert.equal(events.length, 0);
  send(11, 'nowPlaying', { videoId: 'aaaaaaaaaaa', cpn: 'wrong', state: 1 }); assert.equal(events.length, 0);
  send(12, 'nowPlaying', { videoId: track.videoId, state: 1 }); assert.equal(events.length, 0);
  send(13, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn-one', state: 1 }); assert.equal(events[0].event, 'playing');
  assert.equal(events[0].sessionId, 'session-a');
});
test('native ended without playing or without matching nonce never advances', async t => {
  const { adapter, events, send } = adapterFixture(t); await adapter.play(track);
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn', state: 0 }); assert.equal(events.length, 0);
  send(12, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn', state: 1 });
  send(13, 'onStateChange', { cpn: 'different', state: 0 }); send(14, 'onStateChange', { state: 0 }); assert.equal(events.length, 1);
  send(15, 'onStateChange', { cpn: 'cpn', state: 0 }); send(16, 'onStateChange', { cpn: 'cpn', state: 0 }); assert.deepEqual(events.map(x => x.event), ['playing', 'ended']);
});
test('same video requested twice requires a NEW playback nonce', async t => {
  const { adapter, events, send } = adapterFixture(t); await adapter.play(track);
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'old-cpn', state: 1 });
  await adapter.play({ ...track, sessionId: 'session-b' });
  send(12, 'nowPlaying', { videoId: track.videoId, cpn: 'old-cpn', state: 1 }); send(13, 'onStateChange', { cpn: 'old-cpn', state: 0 }); assert.equal(events.length, 1);
  send(14, 'nowPlaying', { videoId: track.videoId, cpn: 'new-cpn', state: 1 }); assert.equal(events[1].sessionId, 'session-b');
});
test('native stop pauses app and detaches current generation; disconnect reports uncertainty', async t => {
  const { adapter, events, send, calls } = adapterFixture(t); await adapter.play(track);
  send(11, 'loungeScreenDisconnected', {}); assert.equal(events[0].event, 'offline');
  await adapter.stop(); send(12, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn', state: 1 }); assert.equal(events.length, 1); assert.equal(calls.at(-1).name, 'pause');
});
test('complete engine + native adapter: confirmed end advances exactly once', async t => {
  const { adapter, send } = adapterFixture(t);
  const engine = new Engine({ store: new MemoryStore(), youtube: { resolve: async () => ({ videoId: track.videoId, title: 'Test song' }) }, adapter });
  await engine.command({ text: '추가 test' }); await engine.command({ text: '추가 test' });
  const first = engine.state.current.sessionId;
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'first-cpn', state: 1 }); await engine.chain; assert.equal(engine.state.current.status, 'playing');
  send(12, 'onStateChange', { cpn: 'first-cpn', state: 0 }); await engine.chain;
  assert.notEqual(engine.state.current.sessionId, first); assert.equal(engine.state.history.length, 1);
  send(13, 'onStateChange', { cpn: 'first-cpn', state: 0 }); await engine.chain; assert.equal(engine.state.history.length, 1);
});
test('Lounge remains opt-in; no full computer or local network discovery is required', () => {
  assert.throws(() => new LoungeAdapter({}), { code: 'LOUNGE_OPT_IN' });
});
test('manual change on TV reports external control instead of silently hijacking playback', async t => {
  const { adapter, send, events } = adapterFixture(t); await adapter.play(track);
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'cpn', state: 1 });
  send(12, 'nowPlaying', { videoId: 'aaaaaaaaaaa', cpn: 'external-cpn', state: 1 }); assert.equal(events.at(-2).event, 'external'); assert.equal(events.at(-2).observedVideoId, 'aaaaaaaaaaa'); assert.equal(events.at(-1).event, 'playing'); assert.equal(adapter.target.videoId, 'aaaaaaaaaaa');
});
test('old streaming connection cannot corrupt AID of a freshly reconnected session', async () => {
  let deliver;
  const client = new LoungeClient({ screenId: 'test-screen' }, { fetcher: async () => new Promise(resolve => { deliver = resolve; }) });
  client.sid = 'old-sid'; client.gsession = 'old-gsid'; client.epoch = 1; client.aid = 4;
  const polling = client.poll(new AbortController().signal); await new Promise(resolve => setImmediate(resolve));
  client.epoch = 2; client.aid = 1; client.sid = 'new-sid';
  deliver(response(framed([[100, ['nowPlaying', { state: 0, cpn: 'old' }]]]))); await polling;
  assert.equal(client.aid, 1); assert.equal(client.sid, 'new-sid');
});
test('cancelled long poll preserves session while an actual network failure invalidates it', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  const client = new LoungeClient({}, { fetcher: async () => { throw new Error('network'); } });
  client.sid = 'sid'; client.gsession = 'gsid';
  await assert.rejects(client.poll(controller.signal)); assert.equal(client.sid, 'sid');
  await assert.rejects(client.poll(new AbortController().signal)); assert.equal(client.sid, null);
});

test('command POST frames participate in nonce verification instead of discarding TV events', async () => {
  const seen=[];
  const client=new LoungeClient({}, {fetcher:async()=>response(framed([[12,['nowPlaying',{videoId:track.videoId,cpn:'live',state:1}]]])),onEvent:e=>seen.push(e)});
  client.sid='s';client.gsession='g';client.epoch=1;client.aid=10;
  await client.command('getNowPlaying');assert.equal(seen[0].name,'nowPlaying');assert.equal(client.aid,12);
});
test('TV autoplay disabled before each track and reasserted if TV enables recommendations', async t => {
  const {adapter,calls,send}=adapterFixture(t);await adapter.play(track);
  assert.equal(calls[0].name,'setAutoplayMode');assert.equal(calls[0].params.autoplayMode,'DISABLED');
  assert.equal(calls.filter(x=>x.name==='setPlaylist').length,1);
  send(11,'onAutoplayModeChanged',{autoplayMode:'ENABLED'});await new Promise(r=>setImmediate(r));
  assert.equal(calls.filter(x=>x.name==='setPlaylist').length,1);assert.equal(calls.filter(x=>x.name==='setAutoplayMode').length,3);
  send(12,'onAutoplayModeChanged',{autoplayMode:'DISABLED'});assert.equal(adapter.info().autoplayMode,'DISABLED');
});
test('new BrowserChannel AID sequence remains usable without accepting mismatched playback nonces', async t => {
  const {adapter,events,send}=adapterFixture(t);await adapter.play(track);
  send(90,'nowPlaying',{videoId:track.videoId,cpn:'live',state:1});
  adapter.client.epoch++;adapter.client.aid=0;
  send(1,'nowPlaying',{videoId:track.videoId,cpn:'live',state:1});
  send(2,'onStateChange',{cpn:'stale',state:0});assert.equal(events.filter(x=>x.event==='ended').length,0);
  send(3,'onStateChange',{cpn:'live',state:0});assert.equal(events.filter(x=>x.event==='ended').length,1);
});
test('explicit status query recovers a missed end only from matching real state=0', async t => {
  const {adapter,send}=adapterFixture(t);
  const engine=new Engine({store:new MemoryStore(),youtube:{resolve:async()=>({videoId:track.videoId,title:'queued'})},adapter});
  await engine.command({text:'추가 first'});await engine.command({text:'추가 next'});
  send(11,'nowPlaying',{videoId:track.videoId,cpn:'one',state:1});await engine.chain;
  const current=engine.state.current.sessionId, command=adapter.client.command;
  adapter.client.command=async(name,params)=>{if(name==='getNowPlaying') send(12,'nowPlaying',{videoId:track.videoId,cpn:'one',state:0});return command(name,params)};
  await adapter.requestStatus();await engine.chain;
  assert.notEqual(engine.state.current.sessionId,current);assert.equal(engine.state.history.length,1);
  assert.equal(engine.state.history[0].status,'ended');
});
test('restart attaches to existing TV playback without replay, retaining queued IDs and order', async t => {
  const first=adapterFixture(t),store=new MemoryStore();
  const original=new Engine({store,youtube:{resolve:async q=>({videoId:track.videoId,title:q})},adapter:first.adapter});
  await original.command({text:'추가 one'});await original.command({text:'추가 two'});await original.command({text:'추가 three'});
  first.send(11,'nowPlaying',{videoId:track.videoId,cpn:'original',state:1});await original.chain;
  const ids=store.state.queue.map(x=>x.id), session=store.state.current.sessionId;first.adapter.close();
  const second=adapterFixture(t),restored=new Engine({store,youtube:{},adapter:second.adapter});
  assert.equal(store.state.current.status,'recovery_required');await restored.start();
  assert.equal(second.calls.some(x=>['setPlaylist','play','seekTo'].includes(x.name)),false);
  second.send(11,'nowPlaying',{videoId:track.videoId,state:1});await restored.chain;assert.equal(store.state.current.status,'recovery_required');
  second.send(12,'nowPlaying',{videoId:track.videoId,cpn:'existing-live',state:1});await restored.chain;
  assert.equal(store.state.current.status,'playing');assert.equal(store.state.current.sessionId,session);assert.deepEqual(store.state.queue.map(x=>x.id),ids);
  second.send(13,'onStateChange',{cpn:'existing-live',state:0});await restored.chain;assert.equal(store.state.current.id,ids[0]);assert.equal(store.state.queue[0].id,ids[1]);
});

test('receiver empty-item end needs two real snapshots separated by a new status query', async t => {
  const {adapter,send,events}=adapterFixture(t);await adapter.play(track);
  await adapter.requestStatus();
  send(11,'nowPlaying',{});assert.equal(events.length,0);
  send(12,'nowPlaying',{videoId:track.videoId,cpn:'live',state:1});
  send(13,'nowPlaying',{});send(14,'nowPlaying',{});assert.equal(events.some(x=>x.event==='idle'),false);
  await adapter.requestStatus();send(15,'nowPlaying',{});send(16,'nowPlaying',{});
  assert.equal(events.filter(x=>x.event==='idle').length,1);
});
test('empty snapshots cannot advance paused, buffering, ad or newly reconnected playback', async t => {
  for(const mode of ['paused','buffering','ad','reconnected']) {
    const {adapter,send,events}=adapterFixture(t);await adapter.play(track);send(11,'nowPlaying',{videoId:track.videoId,cpn:'live',state:1});
    if(mode==='paused'||mode==='buffering') send(12,'onStateChange',{cpn:'live',state:mode==='paused'?2:3});
    if(mode==='ad') send(12,'adPlaying',{adState:1});
    if(mode==='reconnected') adapter.client.epoch++;
    send(13,'nowPlaying',{});await adapter.requestStatus();send(14,'nowPlaying',{});
    assert.equal(events.some(x=>x.event==='idle'),false,mode);
  }
});
test('verified receiver idle advances queued item without pretending it was a nonce-confirmed natural end', async t => {
  const {adapter,send}=adapterFixture(t);const store=new MemoryStore();const engine=new Engine({store,youtube:{resolve:async()=>({videoId:track.videoId,title:'song'})},adapter});
  await engine.command({text:'추가 first'});await engine.command({text:'추가 next'});const next=store.state.queue[0].id;
  send(11,'nowPlaying',{videoId:track.videoId,cpn:'first',state:1});await engine.chain;
  await adapter.requestStatus();send(12,'nowPlaying',{});await adapter.requestStatus();send(13,'nowPlaying',{});await engine.chain;
  assert.equal(store.state.current.id,next);assert.equal(store.state.history[0].status,'tv_idle');
});

test('TV manual selections follow verified video+nonce, ignore retired sessions and yield to queued requests after actual playback', async t => {
  const {adapter,send,calls}=adapterFixture(t),store=new MemoryStore();
  const youtube={resolve:async q=>({videoId:q.includes('aaaaaaaaaaa')?'aaaaaaaaaaa':q.includes('bbbbbbbbbbb')?'bbbbbbbbbbb':track.videoId,title:q})};
  const engine=new Engine({store,youtube,adapter});await engine.command({text:'추가 one'});
  send(11,'nowPlaying',{videoId:track.videoId,cpn:'original',state:1});await engine.chain;
  let ids=store.state.queue.map(x=>x.id);const before=calls.filter(x=>x.name==='setPlaylist').length;
  send(12,'nowPlaying',{videoId:'aaaaaaaaaaa',state:1});await engine.chain;assert.equal(store.state.current.videoId,track.videoId);
  send(13,'nowPlaying',{videoId:'aaaaaaaaaaa',cpn:'manual-a',state:1});await engine.chain;
  assert.equal(store.state.current.source,'external_tv');assert.equal(store.state.current.videoId,'aaaaaaaaaaa');assert.equal(store.state.current.status,'playing');assert.deepEqual(store.state.queue.map(x=>x.id),ids);assert.equal(calls.filter(x=>x.name==='setPlaylist').length,before);
  send(14,'onStateChange',{cpn:'original',state:0});send(15,'nowPlaying',{videoId:track.videoId,cpn:'original',state:1});await engine.chain;assert.equal(store.state.current.videoId,'aaaaaaaaaaa');
  send(16,'nowPlaying',{videoId:'bbbbbbbbbbb',cpn:'manual-b',state:3});await engine.chain;assert.equal(store.state.current.status,'buffering');assert.equal(store.state.current.observedPlaying,false);
  send(17,'onStateChange',{cpn:'manual-a',state:0});await engine.chain;assert.equal(store.state.current.videoId,'bbbbbbbbbbb');
  await engine.command({text:'추가 two'});await engine.command({text:'추가 three'});ids=store.state.queue.map(x=>x.id);assert.equal(ids.length,2);
  send(18,'onStateChange',{cpn:'manual-b',state:1});send(19,'onStateChange',{cpn:'manual-b',state:0});await engine.chain;
  assert.equal(store.state.current.id,ids[0]);assert.equal(store.state.queue[0].id,ids[1]);assert.equal(calls.filter(x=>x.name==='setPlaylist').length,before+1);
});
test('restart with a different paused TV selection observes without replay and yields to requests after actual resume', async t=>{
 const first=adapterFixture(t),store=new MemoryStore(),youtube={resolve:async q=>({videoId:track.videoId,title:q})};const old=new Engine({store,youtube,adapter:first.adapter});await old.command({text:'추가 one'});await old.command({text:'추가 two'});first.adapter.close();
 const {adapter,send,calls}=adapterFixture(t),engine=new Engine({store,youtube:{},adapter});const queued=store.state.queue[0].id;await engine.start();send(11,'nowPlaying',{videoId:'aaaaaaaaaaa',cpn:'manual',state:2});await engine.chain;
 assert.equal(store.state.current.source,'external_tv');assert.equal(store.state.current.status,'paused');assert.equal(store.state.paused,true);assert.equal(calls.some(x=>['setPlaylist','play','seekTo'].includes(x.name)),false);
 send(12,'onStateChange',{cpn:'manual',state:0});await engine.chain;assert.equal(store.state.queue[0].id,queued);
 send(13,'onStateChange',{cpn:'manual',state:1});await engine.chain;assert.equal(store.state.paused,false);assert.equal(store.state.current.id,queued);const session=store.state.current.sessionId;send(14,'onStateChange',{cpn:'manual',state:0});await engine.chain;assert.equal(store.state.current.sessionId,session);
});
test('external title lookups cannot overwrite a newer TV selection or block queue observation',async t=>{
 const {adapter,send}=adapterFixture(t),store=new MemoryStore();let finish;const engine=new Engine({store,youtube:{resolve:async()=>({videoId:track.videoId,title:'initial'})},adapter});await engine.command({text:'추가 one'});send(11,'nowPlaying',{videoId:track.videoId,cpn:'initial',state:1});await engine.chain;
 engine.youtube.resolve=q=>q.includes('aaaaaaaaaaa')?new Promise(r=>{finish=r}):Promise.resolve({videoId:'bbbbbbbbbbb',title:'newest title'});
 send(12,'nowPlaying',{videoId:'aaaaaaaaaaa',cpn:'a',state:1});await engine.chain;send(13,'nowPlaying',{videoId:'bbbbbbbbbbb',cpn:'b',state:1});await engine.chain;await new Promise(r=>setImmediate(r));await engine.chain;finish({videoId:'aaaaaaaaaaa',title:'stale title'});await new Promise(r=>setImmediate(r));await engine.chain;assert.equal(store.state.current.videoId,'bbbbbbbbbbb');assert.equal(store.state.current.title,'newest title');
});

test('queued requests preempt a verified manual selection once, preserving FIFO and ignoring the replaced song ending',async t=>{
 const {adapter,send,calls}=adapterFixture(t),store=new MemoryStore(),engine=new Engine({store,youtube:{resolve:async q=>({videoId:track.videoId,title:q})},adapter});await engine.command({text:'추가 one'});await engine.command({text:'추가 two'});await engine.command({text:'추가 three'});send(11,'nowPlaying',{videoId:track.videoId,cpn:'original',state:1});await engine.chain;const ids=store.state.queue.map(x=>x.id),before=calls.filter(x=>x.name==='setPlaylist').length;
 send(12,'nowPlaying',{videoId:'aaaaaaaaaaa',cpn:'manual',state:1});await engine.chain;assert.equal(store.state.current.id,ids[0]);assert.equal(store.state.queue[0].id,ids[1]);assert.equal(store.state.history.at(-1).status,'tv_yielded');assert.equal(calls.filter(x=>x.name==='setPlaylist').length,before+1);send(13,'onStateChange',{cpn:'manual',state:0});await engine.chain;assert.equal(store.state.current.id,ids[0]);
});

test('manual return uses bounded observed seek position in setPlaylist and keeps HTTP acceptance unconfirmed',async t=>{
 const {adapter,calls,send,events}=adapterFixture(t);await adapter.play({...track,resumePositionSeconds:123.5});assert.equal(calls.find(x=>x.name==='setPlaylist').params.currentTime,123.5);assert.equal(events.length,0);
 send(11,'nowPlaying',{videoId:track.videoId,cpn:'live',state:1,currentTime:'124.5',duration:'3600'});assert.equal(events.find(x=>x.event==='position').positionSeconds,124.5);assert.equal(events.find(x=>x.event==='position').durationSeconds,3600);
 assert.deepEqual(adapter.position({currentTime:'NaN',duration:-1}),{});assert.deepEqual(adapter.position({currentTime:Infinity,duration:604801}),{});await adapter.play({...track,resumePositionSeconds:Infinity});assert.equal(calls.filter(x=>x.name==='setPlaylist').at(-1).params.currentTime,0);
});

test('late verified TV playback recovers handshake timeout without replay or accepting stale/unverified events',async t=>{
 const {adapter,send,calls}=adapterFixture(t),store=new MemoryStore(),engine=new Engine({store,youtube:{resolve:async q=>({videoId:track.videoId,title:q})},adapter});await engine.command({text:'추가 one'});engine.state.current.status='error';engine.state.current.error='PLAYBACK_NOT_CONFIRMED';const count=calls.filter(x=>x.name==='setPlaylist').length;
 await engine.nativeEvent({...engine.state.current,event:'playing'});assert.equal(engine.state.current.status,'error');await engine.nativeEvent({...engine.state.current,sessionId:'stale',event:'playing',verifiedObservation:true});assert.equal(engine.state.current.status,'error');send(11,'nowPlaying',{videoId:track.videoId,cpn:'late',state:1});await engine.chain;assert.equal(engine.state.current.status,'playing');assert.equal(engine.state.current.error,undefined);assert.equal(calls.filter(x=>x.name==='setPlaylist').length,count);
 engine.state.current.status='error';engine.state.current.error='DEVICE_ERROR';send(12,'nowPlaying',{videoId:track.videoId,cpn:'late',state:1});await engine.chain;assert.equal(engine.state.current.status,'error');
});

test('separate queried identity fixes stale nowPlaying without applying its clock, end or playback state',async t=>{
 const {adapter,send,calls,events}=adapterFixture(t);await adapter.attach(track);send(11,'nowPlaying',{videoId:track.videoId,cpn:'stale',state:1,currentTime:'100',duration:'500'});events.length=0;
 adapter.identityQueries=1;send(12,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});send(13,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});assert.equal(events.length,0);
 adapter.identityQueries=2;send(14,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});assert.equal(events[0].event,'identity');assert.equal(events[0].observedVideoId,'aaaaaaaaaaa');assert.equal(adapter.target.videoId,'aaaaaaaaaaa');
 events.length=0;send(15,'nowPlaying',{videoId:track.videoId,cpn:'stale',state:1,currentTime:'200',duration:'500'});send(16,'onStateChange',{cpn:'stale',state:0});send(17,'nowPlaying',{});assert.equal(events.length,0);assert.equal(adapter.info().identityConflict,true);assert.equal(calls.some(x=>['setPlaylist','play','pause','seekTo','setAutoplayMode'].includes(x.name)),false);
 send(18,'nowPlaying',{videoId:'aaaaaaaaaaa',cpn:'fresh',state:1});assert.equal(events.at(-1).event,'playing');assert.equal(adapter.info().identityConflict,false);
});
test('identity candidate rejects malformed, unsolicited, ad and prior connection context',async t=>{
 const {adapter,send,events}=adapterFixture(t);await adapter.attach(track);adapter.identityQueries=0;send(11,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});assert.equal(adapter.identityCandidate,null);adapter.identityQueries=1;send(12,'onSubtitlesTrackChanged',{videoId:'evil'});assert.equal(adapter.identityCandidate,null);adapter.target.adActive=true;send(13,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});assert.equal(adapter.identityCandidate,null);adapter.target.adActive=false;send(14,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});adapter.client.epoch++;adapter.identityQueries=2;send(15,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});assert.equal(events.length,0);
});
test('identity-only reconciliation never starts playback, but an explicit request can take priority',async t=>{
 const {adapter,send,calls}=adapterFixture(t),store=new MemoryStore();const engine=new Engine({store,youtube:{resolve:async q=>({videoId:q.includes('aaaaaaaaaaa')?'aaaaaaaaaaa':track.videoId,title:q})},adapter});await engine.command({text:'추가 one'});send(11,'nowPlaying',{videoId:track.videoId,cpn:'original',state:1});await engine.chain;const count=calls.filter(x=>x.name==='setPlaylist').length;
 adapter.identityQueries=1;send(12,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});adapter.identityQueries=2;send(13,'onSubtitlesTrackChanged',{videoId:'aaaaaaaaaaa'});await engine.chain;assert.equal(store.state.current.videoId,'aaaaaaaaaaa');assert.equal(store.state.current.status,'observing');assert.equal(store.state.current.observedPlaying,false);assert.equal(calls.filter(x=>x.name==='setPlaylist').length,count);
 send(14,'nowPlaying',{videoId:track.videoId,cpn:'original',state:0});await engine.chain;assert.equal(store.state.current.videoId,'aaaaaaaaaaa');await engine.command({text:'추가 two'});assert.equal(calls.filter(x=>x.name==='setPlaylist').length,count+1);assert.equal(store.state.manualReturn.videoId,'aaaaaaaaaaa');assert.equal(store.state.manualReturn.resumePositionSeconds,0);
});

test('restart captures playback in the initial bind without resending the song', async t => {
  const { adapter, calls, send } = adapterFixture(t);
  const store = new MemoryStore();
  store.state.current = { ...track, source: 'background', desiredState: 'playing' };
  const poll = adapter.client.poll;
  adapter.client.poll = signal => {
    adapter.client.epoch++;
    send(2, 'nowPlaying', { videoId: track.videoId, cpn: 'bind-observation', state: 1 });
    return poll(signal);
  };
  const engine = new Engine({ store, youtube: {}, adapter });
  await engine.start();
  await engine.chain;
  assert.equal(engine.state.current.status, 'playing');
  assert.equal(calls.some(call => call.name === 'setPlaylist'), false);
});

test('silent TV session renews read-only observations even if the subtitle query fails', async t => {
  const { adapter, calls, send } = adapterFixture(t);
  let at = 1000;
  adapter.now = () => at;
  await adapter.attach(track);
  adapter.client.sid = 'silent';
  const command = adapter.client.command;
  adapter.client.command = async name => {
    await command(name);
    if (name === 'getSubtitlesTrack') throw new Error('subtitle query unavailable');
  };
  at += 45000;
  adapter.statusQueries = 3;
  await adapter.requestStatus();
  assert.equal(adapter.client.sid, null);
  assert.deepEqual(calls.slice(-2).map(call => call.name), ['getSubtitlesTrack', 'getNowPlaying']);
  assert.ok(adapter.info().lastStatusError);
  send(11, 'nowPlaying', { videoId: track.videoId, cpn: 'recovered', state: 1 });
  assert.equal(adapter.info().lastStatusError, null);
});

test('an existing queued song gets priority when the manual video is identified later', async t => {
  const { adapter, calls, send } = adapterFixture(t);
  const store = new MemoryStore();
  store.state.current = { ...track, source: 'background', desiredState: 'playing' };
  const engine = new Engine({ store, youtube: { resolve: async () => ({ videoId: 'bbbbbbbbbbb', title: 'queued song' }) }, adapter });
  await engine.start();
  await engine.command({ text: '추가 test' });
  const queued = engine.state.queue[0].id;
  assert.equal(calls.some(call => call.name === 'setPlaylist'), false);
  adapter.identityQueries = 1;
  send(11, 'onSubtitlesTrackChanged', { videoId: 'aaaaaaaaaaa' });
  adapter.identityQueries = 2;
  send(12, 'onSubtitlesTrackChanged', { videoId: 'aaaaaaaaaaa' });
  await engine.chain;
  assert.equal(engine.state.current.id, queued);
  assert.equal(engine.state.manualReturn.videoId, 'aaaaaaaaaaa');
  assert.equal(calls.filter(call => call.name === 'setPlaylist').length, 1);
});

test('explicit receiver idle after an unconfirmed selection restores queue or BGM', async t => {
  for (const hasQueue of [false, true]) {
    const {adapter, send, calls} = adapterFixture(t);
    const store = new MemoryStore();
    store.state.current = { ...track, source: 'url', desiredState: 'playing', observedPlaying: false };
    const engine = new Engine({store, adapter, background: { enabled: true }, youtube: {
      resolve: async () => ({ videoId: 'aaaaaaaaaaa', title: 'queued', source: 'url' })
    }});
    await engine.start();
    if (hasQueue) await engine.command({text: '추가 test'});
    const nextId = store.state.queue[0]?.id;
    send(11, 'playlistModified', {videoId: track.videoId});
    send(12, 'nowPlaying', {state: 1});
    await adapter.requestStatus();
    send(13, 'nowPlaying', {state: 1});
    await engine.chain;
    assert.equal(calls.some(call => call.name === 'setPlaylist'), false);
    send(14, 'nowPlaying', {});
    send(15, 'nowPlaying', {});
    await engine.chain;
    assert.equal(calls.some(call => call.name === 'setPlaylist'), false);
    await adapter.requestStatus();
    send(16, 'nowPlaying', {});
    await engine.chain;
    assert.equal(store.state.history.at(-1).status, 'tv_idle');
    assert.equal(store.state.current.source, hasQueue ? 'url' : 'background');
    if (hasQueue) assert.equal(store.state.current.id, nextId);
    assert.equal(calls.filter(call => call.name === 'setPlaylist').length, 1);
  }
});
