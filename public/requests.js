'use strict';
(function () {
  const byId = id => document.getElementById(id);
  const form = byId('public-request-form');
  const input = byId('public-query');
  const submit = byId('public-submit');
  const panel = byId('public-request-panel');
  const feedback = byId('public-feedback');
  const results = byId('public-results');
  const choices = byId('public-choices');
  const fallback = byId('public-youtube-search');
  let csrf, canSearch, busy = false, pending;

  function requestId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  }

  function message(text, kind = '') {
    feedback.className = 'feedback' + (kind ? ' ' + kind : '');
    feedback.textContent = text;
  }

  function inputValue() {
    const text = input.value.trim();
    const link = text.match(/https?:\/\/[^\s<>]+/i)?.[0];
    if (!link) return { action: 'search', query: text };
    let playlist = false;
    try { playlist = new URL(link).pathname === '/playlist'; } catch {}
    return { action: playlist ? 'playlist' : 'add', query: link };
  }

  function update() {
    const { action, query } = inputValue();
    submit.disabled = busy || !query;
    submit.textContent = action === 'playlist' ? '목록 신청' : action === 'add' || !canSearch ? '링크 신청' : '검색';
    choices.querySelectorAll('button').forEach(button => {
      button.disabled = busy || button.dataset.added === 'true';
    });
  }

  async function connect() {
    const response = await fetch('/api/public/session', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw Error(data.message || '신청창에 연결하지 못했어요.');
    csrf = data.csrfToken;
    canSearch = data.searchEnabled;
    input.placeholder = canSearch ? '예: 아이유 밤편지' : 'YouTube 영상·재생목록 링크';
    panel.hidden = false;
    update();
  }

  async function send(body, retry = true) {
    const response = await fetch('/api/public/request', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Jukebox-CSRF': csrf },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (retry && response.status === 401 && data.error === 'REQUEST_SESSION') {
      await connect();
      return send(body, false);
    }
    if (!response.ok) throw Object.assign(Error(data.message || '신청을 처리하지 못했어요.'), { status: response.status, code: data.error });
    return data;
  }

  function render(query, result) {
    choices.replaceChildren();
    byId('public-results-title').textContent = '“' + query + '” 검색 결과 ' + result.choices.length + '개';
    result.choices.forEach((song, index) => {
      const row = document.createElement('li');
      const img = document.createElement('img');
      const info = document.createElement('div');
      const title = document.createElement('a');
      const channel = document.createElement('small');
      const button = document.createElement('button');
      row.className = 'public-choice';
      img.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(song.videoId) + '/mqdefault.jpg';
      img.alt = '';
      img.loading = index < 3 ? 'eager' : 'lazy';
      title.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(song.videoId);
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      title.textContent = song.title;
      info.append(title);
      if (song.channelTitle) {
        channel.textContent = song.channelTitle;
        info.append(channel);
      }
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = '＋ 신청';
      button.setAttribute('aria-label', song.title + ' 신청');
      button.onclick = () => perform({ action: 'select', index: index + 1, selectionId: result.selectionId }, button);
      row.append(img, info, button);
      choices.append(row);
    });
    results.hidden = false;
  }

  function showFallback(query) {
    fallback.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    fallback.hidden = false;
  }

  async function perform(payload, button) {
    if (busy) return;
    const searching = payload.action === 'search';
    busy = true;
    if (searching) results.hidden = true;
    fallback.hidden = true;
    message(searching ? 'YouTube에서 찾는 중…' : '대기열에 담는 중…');
    update();
    const key = JSON.stringify(payload);
    if (pending?.key !== key) pending = { key, body: { requestId: requestId(), ...payload } };
    try {
      const result = await send(pending.body);
      pending = null;
      if (searching) {
        render(payload.query, result);
        message(result.choices.length + '곡을 찾았어. 듣고 싶은 곡 옆에 신청을 눌러 줘!', 'success');
      } else {
        message(result.text, 'success');
        if (button) {
          button.dataset.added = 'true';
          button.textContent = '✓ 신청 완료';
          button.setAttribute('aria-label', '신청 완료');
        } else if (inputValue().query === payload.query) input.value = '';
        if (typeof loadQueue === 'function') loadQueue();
      }
    } catch (error) {
      message(error.status ? error.message : '연결이 끊겼어요. 잠시 후 다시 눌러 주세요.', 'error');
      if (error.status && error.status < 500 && error.status !== 429) pending = null;
      if (searching) showFallback(payload.query);
      if (error.code === 'CHOICE_EXPIRED') {
        results.hidden = true;
        input.focus();
      }
    } finally {
      busy = false;
      update();
    }
  }

  form.onsubmit = event => {
    event.preventDefault();
    const payload = inputValue();
    if (!payload.query) return input.focus();
    if (payload.action === 'search' && !canSearch) {
      message('지금은 YouTube 링크로 신청해 줘.', 'error');
      showFallback(payload.query);
      return;
    }
    void perform(payload);
  };
  input.oninput = update;

  connect().catch(error => {
    const unavailable = byId('public-request-unavailable');
    unavailable.hidden = false;
    unavailable.textContent = error.message;
  });
})();
