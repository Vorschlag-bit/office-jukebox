/* ES5 syntax + XMLHttpRequest for older TV browsers. Playback support still needs a real-device test. */
'use strict';
var player, ready = false, active = null, token = '', connected = false, busy = false;
var clientId = 'player-' + Date.now() + '-' + Math.floor(Math.random() * 1000000000);
var reportedState = null;
var reconnectNeedsRecovery = false;
var interruptedSession = null;
var activeVideoId = null;
function notice(text) { document.getElementById('notice').textContent = text; }
function api(path, data, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', path, true); xhr.timeout = 10000;
  xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.onload = function () { var d; try { d = JSON.parse(xhr.responseText); } catch (e) { callback(new Error('서버 응답 오류')); return; } if (xhr.status < 200 || xhr.status >= 300) callback(new Error(d.message)); else callback(null, d); };
  xhr.onerror = xhr.ontimeout = function () { callback(new Error('서버 연결을 확인하세요.')); };
  xhr.send(JSON.stringify(data));
}
function report(event) {
  if (!active || reportedState === event) return;
  if (player && player.getVideoData && player.getVideoData().video_id !== activeVideoId) return;
  reportedState = event;
  api('/api/player/event', { clientId: clientId, sessionId: active, event: event }, function (error) { if (error) { reportedState = null; notice(error.message); } });
}
function stopLocally() {
  // Remove identity before stopVideo: its callback must not report for an old session.
  active = null; activeVideoId = null; reportedState = null;
  if (ready) player.stopVideo();
}
function poll() {
  if (!connected || busy) return;
  busy = true;
  api('/api/player/poll', { clientId: clientId }, function (error, s) {
    busy = false;
    if (error) {
      if (active) interruptedSession = active;
      reconnectNeedsRecovery = true; stopLocally(); notice(error.message);
      document.getElementById('login').hidden = false;
      return;
    }
    document.getElementById('login').hidden = true;
    var current = s.current;
    document.getElementById('title').textContent = current ? current.title : '신청곡을 기다립니다';
    if (!current) { if (active) stopLocally(); reconnectNeedsRecovery = false; notice('연결됨 · 다음 신청곡을 기다립니다.'); return; }
    if (['recovery_required', 'error'].indexOf(current.status) !== -1) { stopLocally(); notice('관리 화면에서 재시도 또는 다음 명령을 실행하세요.'); return; }
    if (current.sessionId !== interruptedSession) reconnectNeedsRecovery = false;
    if (reconnectNeedsRecovery) {
      notice('연결이 복구됐습니다. 관리 화면에서 다음 명령으로 곡을 다시 지정하세요.'); return;
    }
    if (ready && current.sessionId !== active) {
      active = current.sessionId; activeVideoId = current.videoId; reportedState = null;
      player.loadVideoById(current.videoId);
      notice('재생 요청됨 · 소리가 나지 않으면 재생 허용 버튼을 눌러 주세요.');
      document.getElementById('allow').hidden = false;
    }
  });
}
window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player('youtube', { width: '100%', height: '100%', playerVars: { playsinline: 1, origin: window.location.origin }, events: {
    onReady: function () { ready = true; poll(); },
    onStateChange: function (e) {
      if (e.data === 1) { report('playing'); notice('재생 중'); document.getElementById('allow').hidden = true; }
      else if (e.data === 2) report('paused');
      else if (e.data === 0) report('ended');
    },
    onAutoplayBlocked: function () { report('blocked'); notice('자동재생이 차단됐습니다. 아래 버튼을 눌러 주세요.'); document.getElementById('allow').hidden = false; },
    onError: function (e) { report('error'); notice('유튜브 재생 오류 ' + e.data + ' · 관리 화면에서 다음 곡을 선택하세요.'); }
  } });
};
document.getElementById('connect').onclick = function () {
  token = document.getElementById('token').value;
  connected = true; document.getElementById('login').hidden = true;
  if (!window.YT) { var script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.onerror = function () { notice('YouTube 플레이어를 불러오지 못했습니다. 인터넷 연결을 확인하세요.'); }; document.head.appendChild(script); }
  poll();
};
document.getElementById('allow').onclick = function () { if (ready && active) { player.unMute(); player.playVideo(); } };
document.addEventListener('visibilitychange', function () { if (document.hidden && ready && active) player.pauseVideo(); });
setInterval(poll, 2000);
