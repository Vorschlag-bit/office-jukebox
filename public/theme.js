'use strict';
(function () {
  var key = 'jukebox-theme', active = 'usagi';
  var themes = {
    usagi: { name:'우사기', english:'USAGI SNACK ROOM', headline:'우라우라! 오늘도 한 곡 가보자고!', description:'푸루야! 노래도 간식도 같이 나누면 더 신나잖아 ♡', label:'노란 간식방', icon:'/avatar.png', art:'/usagi-cheer.jpg', empty:'/usagi-teatime.jpg', welcome:'우라우라! 신청한 순서대로 폴짝폴짝 ♡', waiting:'쥬르리… 다음 신청곡을 기다려!', sticker:'うらら ♡', source:'https://chiikawawallpaper.com/ja/desktop-wallpaper/usagi' },
    chiikawa: { name:'치이카와', english:'CHIIKAWA SWEET ROOM', headline:'작은 행복을 모아, 한 곡씩 ♡', description:'포근한 딸기우유빛 음악방에서 같이 쉬어 가요.', label:'분홍 디저트방', icon:'/chiikawa-avatar.png', art:'/chiikawa-wallpaper.jpg', empty:'/chiikawa-avatar.png', welcome:'좋아하는 노래를 모아 달콤한 플레이리스트로 ♡', waiting:'다음 곡을 기다리며, 잠깐 쉬어 가요 ♡', sticker:'♡ SWEET DAY', source:'https://chiikawawallpaper.com/ja/desktop-wallpaper/chiikawa' },
    hachiware: { name:'하치와레', english:'HACHIWARE SKY ROOM', headline:'좋은 노래를 찾았어! 같이 듣자 ♪', description:'맑은 하늘, 작은 기타, 오늘의 발견을 나누는 시간.', label:'파란 하늘방', icon:'/hachiware-avatar.png', art:'/hachiware-wallpaper.jpg', empty:'/hachiware-avatar.png', welcome:'새로운 노래를 발견하는 기분, 함께 나눠요 ♪', waiting:'어떤 노래를 만나게 될까? 기대돼 ♪', sticker:'♪ GOOD MUSIC', source:'https://chiikawawallpaper.com/ja/desktop-wallpaper/hachiware' }
  };
  function valid(value) { return Object.prototype.hasOwnProperty.call(themes, value); }
  function apply(value) {
    active = valid(value) ? value : 'usagi';
    var theme = themes[active]; document.body.setAttribute('data-theme', active);
    document.querySelectorAll('[data-theme-pick]').forEach(function(button) { button.setAttribute('aria-pressed',String(button.getAttribute('data-theme-pick') === active)); });
    document.querySelectorAll('[data-theme-text]').forEach(function(node) { var field=node.getAttribute('data-theme-text'); if(typeof theme[field] === 'string') node.textContent=theme[field]; });
    document.querySelectorAll('.brand img').forEach(function(img){img.src=theme.icon;img.alt=theme.name;});
    document.querySelectorAll('.empty-mascot').forEach(function(img){img.src=theme.empty;img.alt=theme.name;});
    document.querySelectorAll('[data-theme-source]').forEach(function(link){link.href=theme.source;});
    var icon=document.querySelector('link[rel="icon"]');if(icon)icon.href=theme.icon;
    document.title=theme.name+' · '+(document.getElementById('shared-title')?'전체 플리':'음악방');
    ['shared-art','current-art'].forEach(function(id){var current=document.getElementById(id);if(current && current.getAttribute('data-idle') === 'true')current.src=theme.art;});
    var note=document.getElementById('theme-status');if(note)note.textContent=theme.name+' · '+theme.label+' 적용 중';
  }
  window.MusicTheme={current:function(){return themes[active];}};
  try { active=localStorage.getItem(key)||'usagi'; } catch (_) {}
  apply(active);
  document.querySelectorAll('[data-theme-pick]').forEach(function(button){button.addEventListener('click',function(){var value=button.getAttribute('data-theme-pick');apply(value);try{localStorage.setItem(key,active);}catch(_){var note=document.getElementById('theme-status');if(note)note.textContent+=' · 저장할 수 없어 이 탭에서만 적용돼요.';}});});
  window.addEventListener('storage',function(event){if(event.key === key)apply(event.newValue);});
})();
