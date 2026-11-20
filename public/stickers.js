'use strict';
(function(){
  var party=document.querySelector('[data-dance-party]');if(!party)return;
  var toggle=party.querySelector('[data-dance-toggle]'),images=party.querySelectorAll('[data-animated-src]'),preference='jukebox-sticker-motion',choice=null,visible=true;
  var reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  try{var stored=localStorage.getItem(preference);if(stored==='on'||stored==='off')choice=stored;}catch(_){}
  function paused(){return choice?choice==='off':reduced.matches;}
  function render(){var resting=paused(),animate=!resting&&!document.hidden&&visible;
    images.forEach(function(img){var source=img.getAttribute(animate?'data-animated-src':'data-still-src');if(img.getAttribute('src')!==source)img.setAttribute('src',source);});
    toggle.textContent=resting?'다시 춤추기 ♫':'움직임 쉬기';toggle.setAttribute('aria-pressed',String(!resting));party.setAttribute('data-motion',animate?'playing':'resting');
  }
  toggle.addEventListener('click',function(){choice=paused()?'on':'off';try{localStorage.setItem(preference,choice);}catch(_){}render();});
  document.addEventListener('visibilitychange',render);reduced.addEventListener('change',render);
  window.addEventListener('storage',function(event){if(event.key===preference){choice=event.newValue==='on'||event.newValue==='off'?event.newValue:null;render();}});
  if(window.IntersectionObserver){var observer=new IntersectionObserver(function(entries){visible=entries[0].isIntersecting;render();},{rootMargin:'80px'});observer.observe(party);}
  render();
})();
