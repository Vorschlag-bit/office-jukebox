import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/player.js', import.meta.url), 'utf8');
function playerEnvironment() {
  const elements = new Map(); const requests = [], responses = []; const loaded = []; let options, interval, hiddenListener;
  const player = { stopVideo() {}, loadVideoById(id) { loaded.push(id); this.id = id; }, playVideo() { this.played = true; }, unMute() { this.unmuted = true; }, pauseVideo() { this.paused = true; }, getVideoData() { return { video_id: this.id }; } };
  function element(id) { if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', value: '' }); return elements.get(id); }
  const document = { hidden: false, getElementById: element, createElement: () => ({}), head: { appendChild() {} }, addEventListener: (type, cb) => { hiddenListener = cb; } };
  class Xhr {
    open(method, path) { this.path = path; } setRequestHeader() {}
    send(body) { requests.push({ path: this.path, body: JSON.parse(body) }); const response = responses.shift() || { status: 200, data: {} }; this.status = response.status; this.responseText = JSON.stringify(response.data); this.onload(); }
  }
  const context = vm.createContext({ document, XMLHttpRequest: Xhr, Date, Math, JSON, Error, setInterval: cb => { interval = cb; }, window: { location: { origin: 'http://localhost:8787' }, YT: true }, YT: { Player: function (id, opts) { options = opts; return player; } } });
  vm.runInContext(source, context); context.window.onYouTubeIframeAPIReady();
  element('token').value = 'test-token';
  const state = (session = 'session-a', status = 'sent_unconfirmed') => ({ current: { sessionId: session, status, videoId: 'dQw4w9WgXcQ', title: '<script>not HTML</script>' } });
  return { context, document, player, element, requests, responses, loaded, state, ready: () => options.events.onReady(), connect: () => element('connect').onclick(), poll: () => interval(), event: (name, data) => options.events[name]({ data }), hide: () => { document.hidden = true; hiddenListener(); } };
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
test('hidden player pauses; old video callback cannot affect a new item', () => {
  const env = playerEnvironment(); env.ready(); env.responses.push({ status: 200, data: env.state() }); env.connect(); env.hide(); assert.equal(env.player.paused, true);
  env.player.id = 'otherVideo1'; const before = env.requests.length; env.event('onStateChange', 0); assert.equal(env.requests.length, before);
});
test('authentication failure reveals token input again', () => {
  const env = playerEnvironment(); env.ready(); env.responses.push({ status: 401, data: { message: 'bad token' } }); env.connect(); assert.equal(env.element('login').hidden, false);
});
