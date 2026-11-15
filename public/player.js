/* ES5/XHR for older displays. Each song owns its player callback generation. */
'use strict';
var player = null, ready = false, apiReady = false, active = null, token = '', connected = false, busy = false;
var clientId = 'player-' + Date.now() + '-' + Math.floor(Math.random() * 1000000000);
var reconnectNeedsRecovery = false, interruptedSession = null, generation = 0, currentTrack = null;
var pendingEvents = [], sendingEvent = false, lastQueued = '', played = false, appliedControl = -1;
function notice(text) { document.getElementById('notice').textContent = text; }
function api(path, data, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', path, true); xhr.timeout = 10000;
  xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.onload = function () {
    var d, error;
    try { d = JSON.parse(xhr.responseText); } catch (e) { callback(new Error('서버 응답 오류')); return; }
    if (xhr.status < 200 || xhr.status >= 300) { error = new Error(d.message); error.status = xhr.status; error.code = d.error; callback(error); }
    else callback(null, d);
  };
  xhr.onerror = xhr.ontimeout = function () { callback(new Error('서버 연결을 확인하세요.')); };
  xhr.send(JSON.stringify(data));
}
function flushEvents() {
  if (sendingEvent || !pendingEvents.length || !connected) return;
  sendingEvent = true;
  var item = pendingEvents[0];
  api('/api/player/event', item, function (error) {
    sendingEvent = false;
    if (!error || error.status === 409) { pendingEvents.shift(); flushEvents(); }
    else notice('재생 상태 전송을 재시도합니다. ' + error.message);
  });
}
function report(session, event, errorCode) {
  if (session !== active || !session) return;
  if (event === 'ended' && !played) return;
  var key = session + ':' + event;
  if (lastQueued === key) return;
  if (pendingEvents.length >= 100) { if (ready) player.pauseVideo(); notice('상태 전송이 누적됐습니다. 서버 연결을 확인하세요.'); return; }
  lastQueued = key;
  pendingEvents.push({ clientId: clientId, sessionId: session, event: event, errorCode: errorCode });
  flushEvents();
}
function stopLocally() {
  active = null; currentTrack = null; ready = false; played = false; generation++;
  if (player) { if (player.destroy) player.destroy(); else player.stopVideo(); player = null; }
}
function applyControl(track) {
  if (!ready || !track || appliedControl === (track.controlVersion || 0)) return;
  appliedControl = track.controlVersion || 0;
  if (track.desiredState === 'paused') player.pauseVideo();
  else if (appliedControl > 0) player.playVideo();
}
function loadTrack(track) {
  stopLocally();
  active = track.sessionId; currentTrack = track; played = false; lastQueued = ''; appliedControl = -1;
  var session = active, mine = generation;
  var host = document.getElementById('video-host'); host.textContent = '';
  var container = document.createElement('div'); container.id = 'youtube'; host.appendChild(container);
  var local = new YT.Player('youtube', { width: '100%', height: '100%', playerVars: { playsinline: 1, origin: window.location.origin }, events: {
    onReady: function (e) {
      if (mine !== generation || session !== active) return;
      player = e && e.target ? e.target : local; ready = true;
      if (player.getIframe) player.getIframe().setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
      player.loadVideoById(track.videoId); applyControl(currentTrack);
    },
    onStateChange: function (e) {
      if (mine !== generation || session !== active) return;
      if (e.data === 1) { played = true; report(session, 'playing'); notice('재생 중'); document.getElementById('allow').hidden = true; }
      else if (e.data === 2) { report(session, 'paused'); notice('일시정지됨 · 영상의 재생 버튼 또는 계속을 눌러 주세요.'); }
      else if (e.data === 0) report(session, 'ended');
    },
    onAutoplayBlocked: function () {
      if (mine !== generation || session !== active) return;
      report(session, 'blocked'); notice('자동재생이 차단됐습니다. 아래 버튼을 눌러 주세요.'); document.getElementById('allow').hidden = false;
    },
    onError: function (e) {
      if (mine !== generation || session !== active) return;
      report(session, 'error', e.data); notice('유튜브 재생 오류 ' + e.data + ' · 관리 화면에서 상태를 확인하세요.');
    }
  } });
  player = local;
  notice('재생 요청됨 · 소리가 나지 않으면 재생 허용 버튼을 눌러 주세요.'); document.getElementById('allow').hidden = false;
}
function poll() {
  if (!connected || busy) return;
  busy = true;
  api('/api/player/poll', { clientId: clientId }, function (error, s) {
    busy = false;
    if (error) {
      if (active) interruptedSession = active;
      reconnectNeedsRecovery = true; stopLocally(); notice(error.code === 'LEASE' ? '다른 재생 창을 닫으면 15초 안에 자동 연결돼요.' : error.message); document.getElementById('login').hidden = false;
      if (error.status === 401 && window.parent && window.parent !== window && window.parent.postMessage) window.parent.postMessage({ type: 'jukebox-reconnect' }, window.location.origin);
      return;
    }
    document.getElementById('login').hidden = true; flushEvents();
    var current = s.current;
    document.getElementById('title').textContent = current ? current.title : '신청곡을 기다립니다';
    if (!current) { if (active) stopLocally(); reconnectNeedsRecovery = false; notice(s.paused ? '대기열이 일시정지됐습니다.' : '연결됨 · 다음 신청곡을 기다립니다.'); return; }
    if (['recovery_required', 'error'].indexOf(current.status) !== -1) { stopLocally(); notice('관리 화면에서 재시도 또는 다음 명령을 실행하세요.'); return; }
    if (current.sessionId !== interruptedSession) reconnectNeedsRecovery = false;
    if (reconnectNeedsRecovery) { notice('연결이 복구됐습니다. 관리 화면에서 다음 명령으로 곡을 다시 지정하세요.'); return; }
    if (apiReady && current.sessionId !== active) loadTrack(current);
    else if (current.sessionId === active) { currentTrack = current; applyControl(current); }
  });
}
window.onYouTubeIframeAPIReady = function () { apiReady = true; poll(); };
var apiLoading = false;
function connectToken(value) {
  token = value.trim(); connected = true; document.getElementById('login').hidden = true;
  if (!apiReady && !apiLoading) {
    apiLoading = true; var script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = function () { apiLoading = false; notice('YouTube 플레이어를 불러오지 못했습니다. 인터넷 연결 후 다시 연결하세요.'); document.getElementById('login').hidden = false; };
    document.head.appendChild(script);
  }
  poll();
}
document.getElementById('connect').onclick = function () { connectToken(document.getElementById('token').value); };
if (window.addEventListener) window.addEventListener('message', function (e) {
  if (e.origin !== window.location.origin || e.source !== window.parent || window.parent === window) return;
  if (e.data && e.data.type === 'jukebox-connect' && typeof e.data.token === 'string') {
    document.body.className += ' embedded-player'; connectToken(e.data.token);
  }
});
document.getElementById('allow').onclick = function () { if (ready && active) { player.unMute(); player.playVideo(); } };
document.addEventListener('visibilitychange', function () { if (document.hidden && ready && active) player.pauseVideo(); });
setInterval(poll, 2000);
