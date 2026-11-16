'use strict';
var insecureRemote = window.location.protocol === 'http:' && ['localhost','127.0.0.1','[::1]','::1'].indexOf(window.location.hostname) < 0;
if(insecureRemote) sessionStorage.removeItem('jukebox-admin');
var token = insecureRemote ? '' : sessionStorage.getItem('jukebox-admin') || '', timer, latest = null, capabilities = {}, playerSession = null, requestBusy = false, connectionFailed = false;
function el(id) { return document.getElementById(id); }
function api(path, data) {
  if(insecureRemote) { var blocked = new Error('관리자 연결은 HTTPS 주소를 사용해 주세요.'); blocked.code='TRANSPORT'; return Promise.reject(blocked); }
  return fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }).then(function(r) { return r.json().then(function(d) { if (!r.ok) { var e = new Error(d.message); e.code = d.error; throw e; } return d; }); });
}
var voiceSequence = 0;
function setTone(id,key,fallback) { if(window.MusicTheme) window.MusicTheme.bind(id,key,fallback); else el(id).textContent=fallback; }
function feedback(text, error) { var raw=(error ? '오류: ' : '')+text, seed='web-'+(++voiceSequence); if(window.MusicTheme) window.MusicTheme.feedback(raw,seed,error); else el('feedback').textContent=UsagiVoice.say(raw,seed); el('feedback').className=error?'feedback error':'feedback success'; }
function connection(ok) { setTone('connection',ok?'connected':'disconnected',ok?'푸루! 음악방 연결됨':'후웅? 서버에 다시 연결하는 중'); el('connection-dot').className = 'connection-dot' + (ok ? '' : ' offline'); }
var names = { playing: '재생 중', sent_unconfirmed: '재생 준비 중', dispatching: '재생 준비 중', blocked: '재생 버튼을 눌러 주세요', paused: '일시정지', error: '재생을 확인해 주세요', recovery_required: '다시 재생을 눌러 주세요' };
function artwork(id) { return id ? 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg' : window.MusicTheme ? window.MusicTheme.current().art : '/usagi-cheer.jpg'; }
function refresh() {
  return api('/api/state').then(function(s) {
    latest = s; connection(true); if (connectionFailed) { feedback('다시 연결됐어요. 현재 곡의 상태를 확인해 주세요.'); connectionFailed = false; }
    el('login').hidden = true; el('dashboard').hidden = false;
    if(s.current) {el('title').removeAttribute('data-tone-key');el('title').textContent=s.current.title;} else setTone('title','firstSong','첫 신청곡을 기다립니다.');
    el('current-art').setAttribute('data-idle',String(!s.current)); el('current-art').src = artwork(s.current && s.current.videoId);
    var recovering = s.current && ['error','recovery_required'].indexOf(s.current.status) >= 0;
    el('playback-status').textContent = s.current ? names[s.current.status] || s.current.status : s.paused ? '잠시 쉬는 중' : '대기 중';
    var bodyTone=s.current && s.current.source==='background' && s.current.status==='playing' ? 'bgm' : s.current ? s.current.status==='blocked'?'blockedBody':s.current.status==='recovery_required'?'recoveryBody':s.current.status==='error'?'errorBody':s.current.status==='paused'?'pausedBody':['sent_unconfirmed','dispatching'].indexOf(s.current.status)>=0?s.current.status:'nextBody' : s.paused?'pausedBody':'invite';
    setTone('status',bodyTone,'재생 상태를 확인해 주세요.');
    el('recovery').hidden = !recovering; el('recovery-message').textContent = s.current && s.current.error ? '재생 오류: ' + s.current.error : '자동으로 다시 재생하지 않았어요.';
    var paused = s.paused || (s.current && s.current.status === 'paused');
    el('pause-toggle').textContent = paused ? '▶ 계속 재생' : 'Ⅱ 일시정지'; el('pause-toggle').setAttribute('data-command', paused ? '계속' : '일시정지'); el('pause-toggle').disabled = !!recovering || (!s.current && !s.queue.length && !s.paused);
    el('next-track').disabled = !s.current && !s.queue.length; el('stop').disabled = !s.current && !s.queue.length && !s.paused;
    el('start-player').hidden = !capabilities.embeddedPlayer || !!playerSession; setTone('player-status',s.player.online?'playerOnline':'playerOffline',s.player.online?'재생 화면 연결됨':'이 화면에서 재생을 눌러 영상을 연결하세요.');
    el('queue-count').textContent = s.queue.length + '곡'; setTone('queue-note',s.paused?'queuePaused':'queueNote',s.paused?'대기열이 일시정지됐어요. 계속 재생을 눌러 주세요.':'신청한 순서대로 재생해요.');
    var queue = el('queue'), focusedId = document.activeElement && document.activeElement.getAttribute('data-cancel'); queue.textContent = '';
    s.queue.forEach(function(song, i) { var li = document.createElement('li'), number = document.createElement('span'), img = document.createElement('img'), title = document.createElement('span'), cancel = document.createElement('button'); number.className = 'queue-number'; number.textContent = i + 1; img.src = artwork(song.videoId); img.alt = ''; title.className = 'queue-title'; title.textContent = song.title; cancel.className = 'cancel'; cancel.textContent = '×'; cancel.setAttribute('aria-label', song.title + ' 신청 취소'); cancel.setAttribute('data-cancel',song.id); cancel.title = '신청 취소'; cancel.onclick = function() { command('취소 id:' + song.id); }; li.appendChild(number); li.appendChild(img); li.appendChild(title); li.appendChild(cancel); queue.appendChild(li); if(focusedId === song.id) cancel.focus(); });
    el('empty').hidden = s.queue.length > 0; el('notifications').textContent = s.notifications.failed ? '전달하지 못한 Chat 알림이 있어요.' : '최대 5곡까지 신청할 수 있어요';
  });
}
function refreshFailed(e) { connectionFailed = true; connection(false); if(e.code === 'AUTH' || e.code === 'TRANSPORT') { sessionStorage.removeItem('jukebox-admin'); token=''; el('token').value=''; clearInterval(timer); el('login').hidden = false; el('dashboard').hidden = true; el('login-feedback').textContent = e.message; } }
function command(text) { return api('/api/command', { text: text }).then(function(r) { feedback(r.text); return refresh().then(function() { return r.text; }); }).catch(function(e) { feedback(e.message, true); return null; }); }
function updateCapabilities(c) { capabilities = c; el('shared-queue-link').hidden = !c.sharedQueueEnabled; el('search').hidden = !c.searchEnabled; el('query').placeholder = c.searchEnabled ? '곡명 검색 또는 YouTube 링크 붙여 넣기' : 'YouTube 영상·재생목록 링크를 붙여 넣으세요'; setTone('search-hint',c.searchEnabled?'searchHint':'urlHint',c.searchEnabled?'검색으로 후보를 골라보세요.':'YouTube 공유 링크로 신청하세요.'); }
function connect() {
  token = el('token').value.trim() || token; el('connect').disabled = true; el('login-feedback').textContent = '';
  api('/api/capabilities').then(function(c) { updateCapabilities(c); return refresh(); }).then(function() { sessionStorage.setItem('jukebox-admin',token); el('token').value=''; el('disconnect').hidden=false; clearInterval(timer); timer = setInterval(function() { refresh().catch(refreshFailed); },3000); if(capabilities.embeddedPlayer && sessionStorage.getItem('jukebox-inline-player') === 'yes' && !playerSession) el('start-player').onclick(); }).catch(function(e) { if(e.code==='AUTH'||e.code==='TRANSPORT') { sessionStorage.removeItem('jukebox-admin'); token=''; el('token').value=''; } el('login-feedback').textContent = e.message; }).finally(function() { el('connect').disabled = false; });
}
function renderChoices(text) {
  var choices = el('choices'); choices.textContent = ''; var lines = String(text).split('\n').filter(function(line) { return /^[1-5]\. /.test(line); });
  lines.forEach(function(line) { var button = document.createElement('button'); button.className = 'choice secondary'; button.textContent = line + ' ＋ 신청'; button.onclick = function() { button.disabled = true; command('선택 ' + line.charAt(0)).then(function(result) { if(result) choices.hidden = true; else button.disabled = false; }); }; choices.appendChild(button); }); choices.hidden = !lines.length;
}
el('disconnect').onclick = function() { clearInterval(timer); sessionStorage.removeItem('jukebox-admin'); sessionStorage.removeItem('jukebox-inline-player'); token=''; playerSession=null; latest=null; el('token').value=''; el('embedded-player').src='about:blank'; el('embedded-player').hidden=true; el('dashboard').hidden=true; el('login').hidden=false; el('disconnect').hidden=true; el('login-feedback').textContent='관리자 연결을 종료했어요.'; };
el('connect').onclick = connect; el('token').onkeydown = function(e) { if(e.key === 'Enter') connect(); };
el('help-toggle').onclick = function() { el('help').hidden = !el('help').hidden; if(!el('help').hidden) el('help').scrollIntoView({behavior:'smooth',block:'nearest'}); };
el('search').onclick = function() { var query = el('query').value.trim(); if(!query) return el('query').focus(); el('search').disabled = true; command('검색 ' + query).then(function(text) { if(text) renderChoices(text); el('search').disabled = false; }); };
el('request').onsubmit = function(e) { e.preventDefault(); if(requestBusy) return; var query = el('query').value.trim(); if(!query) return; if(!capabilities.searchEnabled && !/^https:\/\//i.test(query)) { feedback('지금은 YouTube 영상 링크로 신청할 수 있어요. YouTube에서 공유 → 링크 복사를 눌러 주세요.',true); return; } requestBusy = true; el('add').disabled = true; el('add').textContent = '푸루… 담는 중!'; command('추가 ' + query).then(function(text) { if(text) el('query').value = ''; requestBusy = false; el('add').disabled = false; el('add').textContent = '+ 신청하기'; }); };
Array.prototype.forEach.call(document.querySelectorAll('[data-command]'),function(b) { b.onclick = function() { command(b.getAttribute('data-command')); }; });
el('stop').onclick = function() { el('stop-dialog').showModal(); }; el('stop-cancel').onclick = function() { el('stop-dialog').close(); }; el('stop-confirm').onclick = function() { el('stop-dialog').close(); command('정지'); };
function handoffPlayer() { if(playerSession) el('embedded-player').contentWindow.postMessage({type:'jukebox-connect',token:playerSession},window.location.origin); }
el('start-player').onclick = function() { el('start-player').disabled = true; api('/api/playback-session',{}).then(function(r) { playerSession = r.token; sessionStorage.setItem('jukebox-inline-player','yes'); el('embedded-player').hidden = false; el('player-help').hidden = false; el('embedded-player').onload = handoffPlayer; el('embedded-player').src = '/player'; el('start-player').hidden = true; }).catch(function(e) { feedback(e.message,true); }).finally(function() { el('start-player').disabled = false; }); };
var renewingPlayback = false;
window.addEventListener('message', function(e) {
  if(e.origin !== window.location.origin || e.source !== el('embedded-player').contentWindow || !e.data || e.data.type !== 'jukebox-reconnect' || renewingPlayback || !playerSession) return;
  renewingPlayback = true; api('/api/playback-session',{}).then(function(r) { playerSession = r.token; handoffPlayer(); }).catch(function(e) { feedback(e.message,true); }).finally(function() { renewingPlayback = false; });
});
if(token) connect();
