import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/player.js', import.meta.url), 'utf8');
function playerEnvironment() {
  const elements = new Map(); const requests = [], responses = []; const loaded = []; let options, interval, hiddenListener, messageListener;
  const player = { stopVideo() {}, loadVideoById(id) { loaded.push(id); this.id = id; }, playVideo() { this.played = true; }, unMute() { this.unmuted = true; }, pauseVideo() { this.paused = true; }, getVideoData() { return { video_id: this.id }; } };
  function element(id) { if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '', appendChild() {} }); return elements.get(id); }
  const document = { body: { className: "player-page" }, hidden: false, getElementById: element, createElement: () => ({}), head: { appendChild() {} }, addEventListener: (type, cb) => { hiddenListener = cb; } };
  class Xhr {
    open(method, path) { this.path = path; } setRequestHeader() {}
    send(body) { requests.push({ path: this.path, body: JSON.parse(body) }); const response = responses.shift() || { status: 200, data: {} }; this.status = response.status; this.responseText = JSON.stringify(response.data); this.onload(); }
  }
  const context = vm.createContext({ document, XMLHttpRequest: Xhr, Date, Math, JSON, Error, setInterval: cb => { interval = cb; }, window: { parent: {}, addEventListener(type, cb) { if(type === 'message') messageListener = cb; }, location: { origin: 'http://localhost:8787' }, YT: true }, YT: { Player: function (id, opts) { options = opts; return player; } } });
  vm.runInContext(readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8'), context); vm.runInContext(source, context); context.window.onYouTubeIframeAPIReady();
  element('token').value = 'test-token';
  const state = (session = 'session-a', status = 'sent_unconfirmed') => ({ current: { sessionId: session, status, videoId: 'dQw4w9WgXcQ', title: '<script>not HTML</script>' } });
  function makeReady() { if (options) options.events.onReady({ target: player }); }
  return { message: e => messageListener(e), context, document, player, element, requests, responses, loaded, state, ready: makeReady, connect: () => { element('connect').onclick(); makeReady(); }, poll: () => { var previous = options; interval(); if (options && previous !== options) makeReady(); }, event: (name, data) => options.events[name]({ data }), options: () => options, hide: () => { document.hidden = true; hiddenListener(); } };
}
test('TV page uses actual playing event, title is text, same session not reloaded', () => {
  const env = playerEnvironment(); env.ready(); env.responses.push({ status: 200, data: env.state() }); env.connect();
  assert.equal(env.loaded.length, 1); assert.equal(env.element('title').textContent, '<script>not HTML</script>');
  env.responses.push({ status: 200, data: env.state() }); env.poll(); assert.equal(env.loaded.length, 1);
  env.event('onStateChange', 1); assert.equal(env.requests.at(-1).body.event, 'playing');
});
test('autoplay blocked → user gesture resumes unmuted playback', () => {
  const env = playerEnvironment(); env.ready(); env.responses.push({ status: 200, data: env.state() }); env.connect(); env.event('onAutoplayBlocked');
  assert.equal(env.requests.at(-1).body.event, 'blocked'); assert.equal(env.element('allow').hidden, false);
  env.element('allow').onclick(); assert.equal(env.player.played, true); assert.equal(env.player.unmuted, true);
});
test('network recovery holds old session but a fresh operator session can play', () => {
  const env = playerEnvironment(); env.ready(); env.responses.push({ status: 200, data: env.state() }); env.connect();
  env.responses.push({ status: 503, data: { message: 'offline' } }); env.poll();
  env.responses.push({ status: 200, data: env.state() }); env.poll(); assert.equal(env.loaded.length, 1);
  env.responses.push({ status: 200, data: env.state('session-b') }); env.poll(); assert.equal(env.loaded.length, 2);
});
test('recovery required never auto-replays after server restart', () => {
  const env = playerEnvironment(); env.ready(); env.responses.push({ status: 200, data: env.state('s', 'recovery_required') }); env.connect(); assert.equal(env.loaded.length, 0);
});
test('hidden player pauses; old song callbacks cannot affect a new item', () => {
  const env = playerEnvironment(); env.ready(); env.responses.push({ status: 200, data: env.state() }); env.connect(); env.hide(); assert.equal(env.player.paused, true);
  var old = env.options(); env.responses.push({ status: 200, data: env.state('session-b') }); env.poll();
  const before = env.requests.length; old.events.onStateChange({ data: 0 }); assert.equal(env.requests.length, before);
});
test('authentication failure reveals token input again', () => {
  const env = playerEnvironment(); env.ready(); env.responses.push({ status: 401, data: { message: 'bad token' } }); env.connect(); assert.equal(env.element('login').hidden, false);
});
test('lost playing ACK is retried from the event outbox before ended', () => {
  const env = playerEnvironment(); env.responses.push({ status: 200, data: env.state() }); env.connect();
  env.responses.push({ status: 503, data: { message: 'temporary' } }); env.event('onStateChange', 1);
  env.responses.push({ status: 200, data: env.state() }); env.poll();
  assert.equal(env.requests.filter(x => x.body.event === 'playing').length, 2);
  env.event('onStateChange', 0); assert.equal(env.requests.at(-1).body.event, 'ended');
});
test('error 101 is reported even when video metadata could not load', () => {
  const env = playerEnvironment(); env.responses.push({ status: 200, data: env.state() }); env.connect(); env.player.id = '';
  env.event('onError', 101); assert.equal(env.requests.at(-1).body.errorCode, 101);
});
test('old callback cannot skip a repeated request for the SAME video', () => {
  const env = playerEnvironment(); env.responses.push({ status: 200, data: env.state() }); env.connect(); env.event('onStateChange', 1);
  const old = env.options(); env.responses.push({ status: 200, data: env.state('next-session') }); env.poll(); env.event('onStateChange', 1);
  const before = env.requests.length; old.events.onStateChange({ data: 0 }); old.events.onError({ data: 101 }); assert.equal(env.requests.length, before);
});
test('ended before local playing callback is ignored', () => {
  const env = playerEnvironment(); env.responses.push({ status: 200, data: env.state() }); env.connect(); const before = env.requests.length;
  env.event('onStateChange', 0); assert.equal(env.requests.length, before);
});
test('operator pause and resume controls apply only once per version', () => {
  const env = playerEnvironment(); env.responses.push({ status: 200, data: env.state() }); env.connect();
  const paused = env.state(); paused.current.controlVersion = 1; paused.current.desiredState = 'paused'; env.responses.push({ status: 200, data: paused }); env.poll(); assert.equal(env.player.paused, true);
  const resumed = env.state(); resumed.current.controlVersion = 2; resumed.current.desiredState = 'playing'; env.responses.push({ status: 200, data: resumed }); env.poll(); assert.equal(env.player.played, true);
});

test('embedded player accepts a credential only from its same-origin parent', () => {
  const env=playerEnvironment();
  const message={origin:'http://localhost:8787',source:env.context.window.parent,data:{type:'jukebox-connect',token:'ephemeral-test-token'}};
  env.message({...message,origin:'https://evil.example'});assert.equal(env.requests.length,0);
  env.message({...message,source:{}});assert.equal(env.requests.length,0);
  env.responses.push({status:200,data:env.state()});env.message(message);
  assert.match(env.document.body.className,/embedded-player/);assert.equal(env.element('login').hidden,true);assert.equal(env.requests[0].path,'/api/player/poll');
});

test('remote HTTP player never sends a key or claims a playback lease',()=>{
  const env=playerEnvironment();env.context.window.location.protocol='http:';env.context.window.location.hostname='192.0.2.20';env.connect();assert.equal(env.requests.length,0);assert.match(env.element('notice').textContent,/HTTPS/);
});
