'use strict';
var token = sessionStorage.getItem('jukebox-admin') || '';
var timer;
function api(path, data) {
  return fetch(path, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.message); return d; }); });
}
var names = { playing: '재생 중', sent_unconfirmed: '명령 전송됨 · 실제 재생 확인 필요', dispatching: '전송 중', blocked: '자동재생 차단 · 재생 화면에서 버튼을 눌러 주세요', paused: '일시정지', error: '재생 오류 · 현장 확인 후 재시도', recovery_required: '재시작 또는 연결 복구 · 재시도 / 다음 명령 필요' };
function refresh() {
  return api('/api/state').then(function (s) {
    document.getElementById('login').hidden = true; document.getElementById('dashboard').hidden = false;
    document.getElementById('title').textContent = s.current ? s.current.title : '아직 재생 중인 곡이 없습니다';
    document.getElementById('mode').textContent = s.adapter.type;
    document.getElementById('status').textContent = s.current ? names[s.current.status] || s.current.status : s.adapter.type === 'browser' && !s.player.online ? '재생 화면이 연결되지 않았습니다. 신청곡은 대기열에 보관합니다.' : '신청곡을 기다리고 있습니다.';
    var queue = document.getElementById('queue'); queue.textContent = '';
    s.queue.forEach(function (song) { var li = document.createElement('li'); li.textContent = song.title; queue.appendChild(li); });
    document.getElementById('empty').hidden = s.queue.length > 0;
  });
}
function feedback(text) { document.getElementById('feedback').textContent = text; }
function command(text) { return api('/api/command', { text: text }).then(function (r) { feedback(r.text); return refresh(); }).catch(function (e) { feedback(e.message); }); }
function connect() {
  token = document.getElementById('token').value || token;
  refresh().then(function () { sessionStorage.setItem('jukebox-admin', token); clearInterval(timer); timer = setInterval(function () { refresh().catch(function (e) { feedback(e.message); }); }, 3000); }).catch(function (e) { alert(e.message); });
}
document.getElementById('connect').onclick = connect;
document.getElementById('request').onsubmit = function (e) { e.preventDefault(); var q = document.getElementById('query'); command('추가 ' + q.value); q.value = ''; };
Array.prototype.forEach.call(document.querySelectorAll('[data-command]'), function (b) { b.onclick = function () { command(b.getAttribute('data-command')); }; });
if (token) connect();
