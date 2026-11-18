'use strict';
var activeRequest = false, stopped = false;
function byId(id) { return document.getElementById(id); }
var statuses = {observing:'TV 영상 확인됨 · 재생 상태 확인 중',playing:'♪ 지금 재생 중!',paused:'후운~ 잠깐 쉬는 중',sent_unconfirmed:'푸루… TV 재생 확인 중',dispatching:'푸루… 다음 곡 준비 중',recovery_required:'재생 상태를 확인하고 있어. 운영자를 불러 줘!',error:'후와~앙… 재생 확인이 필요해',blocked:'재생 허용을 기다리는 중'};
function queueTone(id,key,fallback) { window.MusicTheme.bind(id,key,fallback); }
function loadQueue() {
  if(activeRequest || stopped) return;
  activeRequest = true;
  return fetch('/api/public/queue',{cache:'no-store',signal:AbortSignal.timeout(10000)}).then(function(r) { return r.json().then(function(s) { if(!r.ok) { if(r.status===404) stopped=true; throw new Error(s.message || '연결을 확인해 줘.'); } return s; }); }).then(function(s) {
    byId('shared-label').textContent=s.current && s.current.status==='playing' ? 'NOW PLAYING ♫' : s.current ? '재생 상태 확인 중' : '다음 노래를 기다려 ♫';
    if(s.adminTlsPort && ['localhost','127.0.0.1','[::1]','::1'].indexOf(window.location.hostname) < 0) { byId('shared-admin').href=window.location.hostname.endsWith('.local') ? '/' : 'https://'+window.location.hostname+':'+s.adminTlsPort+'/'; byId('shared-admin').textContent='HTTPS 관리자 로그인 ↗'; byId('shared-admin-help').hidden=false; }
    if(s.current){byId('shared-title').removeAttribute('data-tone-key');byId('shared-title').textContent=s.current.title;}else queueTone('shared-title','firstSong','첫 신청곡을 기다립니다.');
    queueTone('shared-status',s.current ? (statuses[s.current.status]?s.current.status:'unknown') : s.paused?'queuePaused':'idle','재생 상태 확인 중');
    byId('shared-follow').hidden=!(s.current && s.current.source==='external_tv');
    byId('shared-art').setAttribute('data-idle',String(!s.current));
    byId('shared-art').src = s.current ? 'https://i.ytimg.com/vi/'+encodeURIComponent(s.current.videoId)+'/mqdefault.jpg' : window.MusicTheme.current().art;
    byId('share-url').value=s.shareUrl || window.location.href;
    byId('shared-count').textContent=s.queue.length+'곡';
    byId('shared-queue').textContent='';
    s.queue.forEach(function(song,i) { var row=document.createElement('li'),number=document.createElement('span'),title=document.createElement('span');number.className='queue-number';number.textContent=i+1;title.className='queue-title';title.textContent=song.title;row.appendChild(number);row.appendChild(title);byId('shared-queue').appendChild(row); });
    byId('shared-empty').hidden=!!s.queue.length;
    queueTone('shared-connection','queueConnected','연결됨 · 5초마다 새로고침');
  }).catch(function(e) { if(stopped){byId('shared-connection').removeAttribute('data-tone-key');byId('shared-connection').textContent=e.message;}else queueTone('shared-connection','queueDisconnected','연결이 끊겼어요. 표시된 목록은 마지막으로 받은 정보예요.'); }).finally(function(){activeRequest=false;});
}
byId('shared-refresh').onclick=function(){stopped=false;loadQueue();};
loadQueue();setInterval(function(){if(!document.hidden) loadQueue();},5000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)loadQueue();});

byId('share-copy').onclick=function(){var input=byId('share-url');if(navigator.clipboard && window.isSecureContext){navigator.clipboard.writeText(input.value).then(function(){queueTone('share-help','copyDone','주소를 복사했어요.');}).catch(function(){input.select();queueTone('share-help','copySelected','Ctrl+C 또는 ⌘C로 복사해 주세요.');});}else{input.select();queueTone('share-help','copySelected','Ctrl+C 또는 ⌘C로 복사해 주세요.');}};
