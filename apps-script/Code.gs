/* No OAuth scopes, external requests, triggers, billing or service-account keys. */
var JB_TTL = 300000;
function jbProps() { return PropertiesService.getScriptProperties(); }
function jbHash(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function jbRead(p, k, fallback) { var v = p.getProperty(k); return v ? JSON.parse(v) : fallback; }
function jbWrite(p, k, v) { p.setProperty(k, JSON.stringify(v)); }
function jbSpaces(p) { var a = jbRead(p, 'ALLOWED_SPACES', []); if (!Array.isArray(a) || a.length > 10 || a.some(function(s) { return !/^spaces\/[A-Za-z0-9_-]+$/.test(s); })) throw Error('CONFIG'); return a; }
function jbLocked(f) { var l = LockService.getScriptLock(); if (!l.tryLock(1000)) throw Error('BUSY'); try { return f(jbProps()); } finally { l.releaseLock(); } }
function jbWebUrl(value) { var m=/^http:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local):([0-9]{1,5})\/queue$/.exec(value || ''); return m && Number(m[2])>0 && Number(m[2])<=65535 ? value : null; }
function jbSafe(s) { return String(s).replace(/</g, '‹').replace(/>/g, '›'); }
function jbIndex(p, key, prefix, ttl, now) {
  var ids = jbRead(p, key, []), live = [];
  ids.forEach(function(id) { var r = jbRead(p, prefix + id, null); if (r && now - r.at <= ttl) live.push(id); else p.deleteProperty(prefix + id); });
  if (JSON.stringify(ids) !== JSON.stringify(live)) jbWrite(p, key, live);
  return live;
}
function jbRemember(p, index, prefix, id, value, max, ttl, now) {
  var ids = jbIndex(p, index, prefix, ttl, now);
  if (ids.indexOf(id) < 0) ids.push(id);
  while (ids.length > max) p.deleteProperty(prefix + ids.shift());
  jbWrite(p, prefix + id, value); jbWrite(p, index, ids);
}
function onAddedToSpace() { return {}; }
function jbHandleMessage(e) {
  try {
    var payload = e.chat && e.chat.messagePayload;
    var m = (payload && payload.message) || e.message || {};
    var space = (payload && payload.space && payload.space.name) || (e.space && e.space.name) || (m.space && m.space.name);
    var u = m.sender || e.user || (e.chat && e.chat.user) || {};
    if (u.type === 'BOT' || !/^users\/[A-Za-z0-9_-]+$/.test(u.name || '') || !/^spaces\/[A-Za-z0-9_-]+$/.test(space || '')) return { text: '지원하지 않는 이벤트입니다.' };
    // Slash commands must keep the command name even when argumentText only contains arguments.
    var text = m.slashCommand ? m.text : m.argumentText;
    if (typeof text !== 'string') {
      text = m.text || '';
      (m.annotations || []).filter(function(a) { return a.type === 'USER_MENTION' && a.userMention && a.userMention.user.type === 'BOT'; }).sort(function(a,b) { return b.startIndex-a.startIndex; }).forEach(function(a) { var s = a.startIndex || 0; text = text.slice(0,s) + text.slice(s+a.length); });
    }
    text = text.trim().replace(/^\//, '');
    if (!text) text = '메뉴';
    if (text === 'result') text = '결과';
    if (text === 'info') text = '내정보';
    if (text === '내정보') return { text: '스페이스: ' + space + '\n사용자: ' + u.name + '\n리소스 ID는 비밀 키가 아닙니다. 공개 저장소에는 올리지 마세요.' };
    if (!text || text.length > 500 || !m.name || m.name.length > 250) return { text: '명령은 1~500자이며 메시지 ID가 필요합니다.' };
    return jbLocked(function(p) {
      if (jbSpaces(p).indexOf(space) < 0) return { text: '허용되지 않은 스페이스입니다. 내정보로 ID를 확인하고 ALLOWED_SPACES를 설정하세요.' };
      if (text === '익명메뉴') return jbPanel(p, space, u.name, '푸루야! 선곡자는 다른 참여자에게 표시하지 않아. 신청은 아래 비공개 신청창에서!');
      if (['웹','사이트','음악방','web','website'].indexOf(text)>=0) return jbPanel(p, space, u.name, '웹 음악방에서 곡명 검색과 링크 신청을 할 수 있어!');
      if (['메뉴', 'menu', '도움말', '명령어', 'help'].indexOf(text) >= 0) return jbPanel(p, space, u.name, '링크를 붙여 넣고 신청 버튼을 누르세요. 재생 제어와 결과 조회도 버튼으로 할 수 있어요.');
      if (['플리', '전체플리', '전체 플리', '대기열', 'queue'].indexOf(text) >= 0 && (p.getProperty('VIEW') || /플리/.test(text))) return jbQueuePanel(p, 0);
      if (['상태', 'status'].indexOf(text) >= 0 && p.getProperty('VIEW')) return jbPanel(p, space, u.name, '현재 음악방 상태입니다.');
      if (text === '결과') {
        var r = jbRead(p, 'r_' + jbHash(space + '/' + u.name), null);
        return jbPanel(p, space, u.name, r && Date.now() - r.at < 86400000 ? jbSafe(r.text) + '\n[노트북 처리 결과: ' + new Date(r.at).toISOString() + ']' : '아직 처리 결과가 없어요. 신청 후 잠시 기다렸다 결과 확인을 눌러 주세요.');
      }
      if (text === '기능요청함') return jbFeedbackInbox(p, space, u.name);
      if (text === '기능요청') return { text: '푸루야! 개발자에게 남길 기능이나 개선 의견을 적어 줘.', cardsV2: [{ cardId: 'feedback', card: { sections: [{ widgets: [{ buttonList: { buttons: [jbDialogButton('기능 요청 쓰기', 'feedback-open')] } }] }] } }] };
      var verb = text.split(/\s+/)[0].toLowerCase();
      if (['목록','재생목록','playlist','추가','재생','add','play','검색','search','선택','select','취소','cancel','대기열','queue','상태','status','일시정지','pause','계속','resume','다음','next','정지','stop','재시도','retry','확인','confirm'].indexOf(verb) < 0) return jbPanel(p, space, u.name, '버튼으로 신청하고 제어할 수 있어요. 아래에서 원하는 동작을 골라 주세요.');
      var now = Date.now(), eventAt = Date.parse(e.eventTime || (e.chat && e.chat.eventTime) || m.createTime || '');
      if (!isFinite(eventAt) || now - eventAt > JB_TTL || eventAt - now > 60000) return { text: '만료되었거나 시간이 잘못된 요청입니다. 새 명령을 보내세요.' };
      var secret = p.getProperty('SHARED_SECRET');
      if (!secret || secret.length < 32) return { text: 'SHARED_SECRET 설정이 필요합니다.' };
      var id = jbHash(m.name);
      if (p.getProperty('s_' + id)) return e.jukeboxDialog ? { accepted: true } : { text: '이미 접수한 요청입니다. 결과 명령으로 확인하세요.' };
      var ids = jbIndex(p, 'QUEUE', 'q_', JB_TTL, now);
      if (ids.length >= 50) return { text: '중계 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.' };
      var record = { id: id, text: text, space: space, user: u.name, at: eventAt };
      if (e.jukeboxSelectionId) record.selectionId = e.jukeboxSelectionId;
      // Save command before dedup marker: an interrupted handler must not silently lose it.
      jbWrite(p, 'q_' + id, record); if (ids.indexOf(id) < 0) ids.push(id); jbWrite(p, 'QUEUE', ids);
      jbRemember(p, 'SEEN', 's_', id, { at: now }, 100, 86400000, now);
      try { CacheService.getScriptCache().put('JUKEBOX_QUEUE_WAKE', id, 15); } catch (_) { /* The next pull still reads the queue. */ }
      return e.jukeboxDialog ? { accepted: true } : jbPanel(p, space, u.name, '접수했습니다. 보통 5~10초 안에 처리해요. 아래 결과 확인 버튼으로 진행 상황을 볼 수 있어요.');
    });
  } catch (_) { return { text: '중계가 일시 중단되었습니다. 잠시 후 재시도하거나 Apps Script 설정·할당량을 확인하세요.' }; }
}
function doPost(e) {
  var result, waiting;
  try {
    var body = e && e.postData && e.postData.contents;
    if (typeof body !== 'string' || body.length > 240000) throw Error('BODY');
    var r = JSON.parse(body), now = Date.now();
    if (r.v !== 1 || !Number.isFinite(r.ts) || Math.abs(now-r.ts) > 60000 || !/^[a-zA-Z0-9_-]{16,80}$/.test(r.nonce || '') || ['check','pull','ack','result'].indexOf(r.op) < 0 || typeof r.payload !== 'string' || r.payload.length > 120000 || !/^[a-f0-9]{64}$/.test(r.signature || '')) throw Error('AUTH');
    result = jbLocked(function(p) {
      var secret = p.getProperty('SHARED_SECRET'); if (!secret || secret.length < 32) throw Error('AUTH');
      var expected = Utilities.computeHmacSha256Signature('1\n'+r.ts+'\n'+r.nonce+'\n'+r.op+'\n'+r.payload, secret, Utilities.Charset.UTF_8).map(function(b) { return ('0'+((b+256)%256).toString(16)).slice(-2); }).join('');
      var diff = 0; for (var i=0; i<64; i++) diff |= expected.charCodeAt(i) ^ r.signature.charCodeAt(i); if (diff) throw Error('AUTH');
      var cache = CacheService.getScriptCache(); if (cache.get(r.nonce)) throw Error('REPLAY'); cache.put(r.nonce,'1',120);
      var d = JSON.parse(r.payload), spaces = jbSpaces(p);
      if (r.op === 'check') return { ok: true, protocol: 1, allowedSpaces: spaces };
      if (r.op === 'result') {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(d.id || '') || spaces.indexOf(d.space) < 0 || !/^users\/[A-Za-z0-9_-]+$/.test(d.user || '') || typeof d.text !== 'string' || d.text.length > 1500) throw Error('RESULT');
        var done = jbIndex(p, 'RECEIPTS', 'd_', 86400000, now);
        if (done.indexOf(d.id) < 0) {
          var search = d.search;
          var result = { at: now, text: d.text };
          if (search && /^[a-f0-9-]{36}$/.test(search.selectionId || '') && Number.isFinite(search.expiresAt) && Array.isArray(search.titles) && search.titles.length <= 5 && search.titles.every(function(title) { return typeof title === 'string' && title.length <= 180; })) result.search = search;
          if (/^[a-f0-9]{64}$/.test(d.commandId || '')) {
            var pending = jbRead(p, 'sp_' + d.commandId, null);
            if (pending && pending.space === d.space && pending.user === d.user) {
              jbWrite(p, 'sp_' + d.commandId, Object.assign({space: d.space, user: d.user}, result));
            }
          }
          jbRemember(p, 'RESULTS', 'r_', jbHash(d.space+'/'+d.user), result, 50, 86400000, now);
          jbRemember(p, 'RECEIPTS', 'd_', d.id, { at: now }, 100, 86400000, now);
        }
        return { ok: true };
      }
      if (!/^[a-zA-Z0-9_-]{16,80}$/.test(d.clientId || '')) throw Error('CLIENT');
      var worker = jbRead(p,'WORKER',null);
      if (worker && worker.until > now && worker.id !== d.clientId) throw Error('WORKER_BUSY');
      var ids = jbIndex(p,'QUEUE','q_',JB_TTL,now);
      if (r.op === 'pull') {
        jbWrite(p,'WORKER',{ id:d.clientId,until:now+45000 });
        var queueRevision = jbSaveQueueView(p, d.queueView, d.view);
        if (d.view && Array.isArray(d.view.queue) && d.view.queue.length <= 8 && Number.isInteger(d.view.queueCount) && d.view.queueCount >= 0 && d.view.queueCount <= 500 && typeof d.view.paused === 'boolean' && typeof d.view.searchEnabled === 'boolean' && d.view.queue.every(function(x) { return x && typeof x.title === 'string' && x.title.length <= 180; }) && (!d.view.current || (typeof d.view.current.title === 'string' && d.view.current.title.length <= 180 && typeof d.view.current.status === 'string' && d.view.current.status.length <= 30))) { jbWrite(p, 'VIEW', { at: now, current: d.view.current, queue: d.view.queue, queueCount: d.view.queueCount, memberPlaybackControls: d.view.memberPlaybackControls === true, paused: d.view.paused, searchEnabled: d.view.searchEnabled, playerOnline: !!d.view.playerOnline, queueRevision: queueRevision, webUrl: jbWebUrl(d.view.webUrl) }); }
        if (Array.isArray(d.view && d.view.feedbackOperators) && d.view.feedbackOperators.length <= 20 && d.view.feedbackOperators.every(function(user) { return /^users\/[A-Za-z0-9_-]+$/.test(user); })) {
          var operators = JSON.stringify(d.view.feedbackOperators);
          if (d.view.feedbackOperators.every(function(user) { return user.length <= 150; }) && p.getProperty('FEEDBACK_OPERATORS') !== operators) p.setProperty('FEEDBACK_OPERATORS', operators);
        }
        if (!ids.length && d.waitForCommand === true) waiting = { clientId: d.clientId, wake: cache.get('JUKEBOX_QUEUE_WAKE') };
        return { ok:true,command:jbLeaseCommand(p, ids, now),queueRevision:queueRevision };
      }
      var c = jbRead(p,'q_'+d.id,null);
      if (c && (c.lease !== d.lease || c.until < now)) throw Error('LEASE');
      if (c) { jbWrite(p,'QUEUE',ids.filter(function(id) { return id !== d.id; })); p.deleteProperty('q_'+d.id); }
      return { ok:true };
    });
    if (waiting) {
      var deadline = Date.now() + 5000, cache = CacheService.getScriptCache();
      while (Date.now() < deadline) {
        if (cache.get('JUKEBOX_QUEUE_WAKE') !== waiting.wake) {
          result.command = jbLocked(function(p) {
            var at = Date.now(), worker = jbRead(p, 'WORKER', null);
            if (!worker || worker.id !== waiting.clientId || worker.until <= at) return null;
            return jbLeaseCommand(p, jbIndex(p, 'QUEUE', 'q_', JB_TTL, at), at);
          });
          if (result.command) break;
          waiting.wake = cache.get('JUKEBOX_QUEUE_WAKE');
        }
        Utilities.sleep(300);
      }
    }
  } catch (_) { result = { ok:false, error:'BRIDGE_REJECTED' }; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function jbLeaseCommand(p, ids, now) {
  if (!ids.length) return null;
  var command = jbRead(p, 'q_' + ids[0], null);
  if (command.until > now) return null;
  command.lease = Utilities.getUuid();
  command.until = now + 30000;
  jbWrite(p, 'q_' + command.id, command);
  return command;
}

function jbHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); }
// Ten bounded rows per property stay below Apps Script's per-value byte limit.
function jbSaveQueueView(p, incoming, view) {
  var old = jbRead(p, 'QUEUE_VIEW', null);
  if (incoming !== undefined) {
    if (!incoming || !/^[a-f0-9]{64}$/.test(incoming.revision || '') || !Array.isArray(incoming.songs) || incoming.songs.length > 500 || !view || incoming.songs.length !== view.queueCount || !incoming.songs.every(function(x) { return x && /^[a-f0-9-]{36}$/.test(x.id || '') && typeof x.title === 'string' && Array.from(x.title).length <= 80; })) throw Error('QUEUE_VIEW');
    if (!old || old.revision !== incoming.revision) {
      var pages = Math.ceil(incoming.songs.length / 10);
      for (var i = 0; i < pages; i++) jbWrite(p, 'QV_' + i, incoming.songs.slice(i * 10, i * 10 + 10).map(function(x) { return { id: x.id, title: x.title }; }));
      for (var i = pages; old && i < old.pages; i++) p.deleteProperty('QV_' + i);
      old = { revision: incoming.revision, count: incoming.songs.length, pages: pages };
      jbWrite(p, 'QUEUE_VIEW', old);
    }
  }
  return old && view && old.count === view.queueCount ? old.revision : null;
}
function jbQueuePanel(p, page, revision, dialog) {
  var view = jbRead(p, 'VIEW', null), manifest = jbRead(p, 'QUEUE_VIEW', null);
  if (!view || !manifest || view.queueRevision !== manifest.revision) {
    var message = '후운~ 전체 플리를 받아오는 중이야. 잠시 후 전체 플리를 다시 눌러 줘.';
    return dialog ? jbDialogStatus('UNAVAILABLE', message) : { text: message };
  }
  var changed = revision && revision !== manifest.revision;
  page = changed ? 0 : Math.max(0, Math.min(page, Math.max(0, manifest.pages - 1)));
  var rows = jbRead(p, 'QV_' + page, []), stale = Date.now() - view.at >= 30000;
  var widgets = [{ textParagraph: { text: jbHtml((stale ? '⚠ 연결이 끊겨 마지막으로 받은 목록이야.\n' : '') + (changed ? '플리가 바뀌어서 첫 페이지부터 보여 줄게!\n' : '') + (view.current ? '지금: ' + view.current.title : '지금 재생 중인 곡 없음') + '\n대기 ' + manifest.count + '곡 · ' + (page + 1) + '/' + Math.max(1, manifest.pages) + ' 페이지') } }];
  if (!manifest.count) widgets.push({ textParagraph: { text: '쥬르리… 대기곡이 없어. 좋아하는 노래 데려와 줘 ♡' } });
  else rows.forEach(function(song, i) { widgets.push({ textParagraph: { text: jbHtml((page * 10 + i + 1) + '. ' + song.title) } }); });
  var buttons = [];
  if (dialog) {
    if (page > 0) buttons.push(jbButton('‹ 이전 10곡', 'queue-dialog:' + (page - 1) + ':' + manifest.revision));
    if (page + 1 < manifest.pages) buttons.push(jbButton('다음 10곡 ›', 'queue-dialog:' + (page + 1) + ':' + manifest.revision));
    buttons.push(jbButton('↻ 최신 플리', 'queue-dialog:0'));
  } else {
    buttons.push(jbDialogButton('전체 플리 열기', 'queue-open'));
  }
  widgets.push({ buttonList: { buttons: buttons } });
  var card = { header: { title: '우사기 · 전체 플리' }, sections: [{ widgets: widgets }] };
  return dialog ? jbDialog(card) : { text: '이~! 우리 음악방 전체 플리야 ♫', cardsV2: [{ cardId: 'jukebox-queue', card: card }] };
}
function jbButton(label, command, required) {
  var action = { function: 'onCardClick', parameters: [{ key: 'command', value: command }] };
  if (required) action.requiredWidgets = [required];
  return { text: label, onClick: { action: action } };
}
function jbPanel(p, space, user, message) {
  var view = jbRead(p, 'VIEW', null), fresh = view && Date.now() - view.at < 30000;
  var statusNames = { playing: '재생 중 · 우라라라~♪', paused: '일시정지 · 후운~ 쉬어가자', blocked: '화면에서 재생 허용이 필요해요', sent_unconfirmed: '재생 준비 중', dispatching: '재생 준비 중', error: '재생 오류 · 다시 재생 또는 다음 곡', recovery_required: '서버가 복구됐어요 · 다시 재생을 눌러 주세요' };
  var widgets = [];
  var webUrl = view && jbWebUrl(view.webUrl);
  if (webUrl) widgets.push({ textParagraph: { text: '<b>🌐 웹 음악방 열기</b><br>위 주소에서 바로 검색하고 곡을 골라 줘! 회사 Wi-Fi에서 열려.' } });
  if (view) {
    var summary = fresh ? (view.current ? '♫ ' + view.current.title + '\n' + (statusNames[view.current.status] || view.current.status) : '쥬르리… 첫 신청곡을 기다리는 중!') : '노트북 연결이 잠시 끊겼어요. 서버가 켜져 있는지 확인해 주세요.';
    if (view.paused) summary += '\n대기열 일시정지 · 계속 버튼으로 다시 시작';
    summary += '\n\n다음 곡 ' + view.queueCount + '개' + (view.queue.length ? '' : ' · 비어 있어요');
    if (view.queueCount > view.queue.length) summary += '\n외 ' + (view.queueCount-view.queue.length) + '곡';
    widgets.push({ textParagraph: { text: jbHtml(summary) } });
  }
  widgets.push({ buttonList: { buttons: [jbDialogButton('♫ 전체 플리', 'queue-open'), jbButton('↻ 상태 새로고침', '메뉴')] } });
  var sections = [{ widgets: widgets }, { header: '선곡자는 숨기고, 음악은 함께!', widgets: [
    { textParagraph: { text: '푸루야! 검색이나 링크 신청은 아래 버튼을 눌러 줘. 함께 보는 플리에는 곡만 표시돼.' } },
    { buttonList: { buttons: [jbDialogButton('비공개 신청창 열기', 'open-anonymous'), jbDialogButton('내 신청 결과 · 비공개', 'open-private-result'), jbDialogButton('기능 요청', 'feedback-open')] } }
  ] }];
  if (view && view.searchEnabled) sections[1].widgets.unshift({ buttonList: { buttons: [jbDialogButton('🔎 곡 검색', 'search-open')] } });
  var result = jbRead(p, 'r_' + jbHash(space + '/' + user), null);
  if (user && result && result.search && result.search.expiresAt > Date.now()) {
    sections.push({ header: '검색 결과에서 고르기', widgets: jbResultChoices(result.search, 'result-pick:') });
  }
  var paused = view && (view.paused || view.current && view.current.status === 'paused');
  var controls = [jbButton(paused ? '▶ 계속 재생' : 'Ⅱ 일시정지', paused ? '계속' : '일시정지'), jbButton('⏭ 다음 곡', '다음'), jbButton('정지 · 비우기', 'confirm-stop')];
  sections.push({ header: view && view.memberPlaybackControls ? '재생 제어 · 모든 참여자' : '재생 제어 · 운영자', widgets: [{ buttonList: { buttons: controls } }] });
  if (view && view.memberPlaybackControls) sections.push({ widgets: [{textParagraph:{text:'다음 곡·정지·일시정지·계속은 누구나 사용할 수 있어! 정지하면 대기열과 원래 곡 복귀 예약도 모두 비워져.'}}] });
  if (view && view.current && ['error', 'recovery_required'].indexOf(view.current.status) >= 0) sections.push({header:'복구 · 운영자 전용',widgets:[{buttonList:{buttons:[jbButton('다시 재생 · 운영자', '재시도')]}}]});
  if (view && view.queue.length) sections.push({ header: '다음 곡 · 취소할 곡을 누르세요', widgets: view.queue.map(function(song, i) {
    if (/^[a-f0-9-]{36}$/.test(song.id || '')) return { buttonList: { buttons: [jbButton((i+1) + '. ' + song.title.slice(0, 55) + '  × 취소', '취소 id:' + song.id)] } };
    return { textParagraph: { text: jbHtml((i+1) + '. ' + song.title) } };
  }) });
  return { text: (webUrl ? '🌐 웹에서 바로 검색·신청 · 회사 Wi-Fi\n' + webUrl + '\n\n' : '') + message, cardsV2: [{ cardId: 'jukebox-menu', card: { header: { title: '우사기 음악방', subtitle: '🔒 나만 보임', imageUrl: 'https://raw.githubusercontent.com/Vorschlag-bit/office-jukebox/13372d5993a41d405521e5d24e2a642125c757a1/public/avatar.png', imageType: 'CIRCLE' }, sections: sections } }] };
}
function jbHandleClick(e) {
  try {
    var common = e.common || e.commonEventObject || {}, parameters = common.parameters || {};
    (e.action && e.action.parameters || []).forEach(function(x) { parameters[x.key] = x.value; });
    var command = parameters.command, inputs = common.formInputs || e.formInputs || {};
    function field(name) { var x = inputs[name]; x = x && (x[''] || x); return x && x.stringInputs && x.stringInputs.value && String(x.stringInputs.value[0] || '').trim() || ''; }
    var space = e.space && e.space.name || e.message && e.message.space && e.message.space.name, user = e.user || {};
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(space || '') || !/^users\/[A-Za-z0-9_-]+$/.test(user.name || '') || user.type === 'BOT') return { text: '지원하지 않는 이벤트입니다.' };
    if (jbSpaces(jbProps()).indexOf(space) < 0) return { text: '허용되지 않은 스페이스입니다.' };
    if (/^feedback-/.test(command || '')) return jbFeedbackDialog(e, command, field, space, user);
    if (/^search-/.test(command || '')) return jbSearchDialog(e, command, field, space, user);
    if (/^(선택 [1-5]|anonymous-select:[1-5])$/.test(command || '')) {
      var refresh = '이전 검색 버튼이야. 곡 검색 또는 내 신청 결과를 다시 열어 줘.';
      return e.dialogEventType ? jbDialogStatus('INVALID_ARGUMENT', refresh) : { text: refresh };
    }
    if (/^(result-pick:|anonymous-pick:)/.test(command || '')) return jbPickLatestResult(e, command, space, user);
    if (command === 'queue-open' && e.dialogEventType === 'REQUEST_DIALOG') {
      return jbLocked(function(p) { return jbQueuePanel(p, 0, null, true); });
    }
    var page = /^queue-dialog:([0-9]{1,2})(?::([a-f0-9]{64}))?$/.exec(command || '');
    if (page && e.dialogEventType === 'SUBMIT_DIALOG') {
      return jbLocked(function(p) { return jbQueuePanel(p, Number(page[1]), page[2], true); });
    }
    // Legacy buttons cannot open a dialog and some clients post their replies publicly.
    if (/^queue-page:/.test(command || '') || command === '결과') return {};
    if (e.dialogEventType || /^(open-anonymous|open-private-result|anonymous-)/.test(command || '')) return jbAnonymousDialog(e, command, field, space, user);
    if (command === 'confirm-stop') return { actionResponse: { type: 'UPDATE_MESSAGE' }, text: '재생을 멈추고 대기열을 모두 비울까요?', cardsV2: [{ cardId: 'confirm-stop', card: { sections: [{ widgets: [{ buttonList: { buttons: [jbButton('돌아가기', '메뉴'), jbButton('정지하고 모두 비우기', '정지')] } }] }] } }] };
    if (command === 'submit-add' || command === 'submit-search' || command === 'submit-playlist') { var song = field('song'); if (!song || song.length > 300) return { text: 'YouTube 영상 링크 또는 곡명을 입력해 주세요. 최대 300자입니다.' }; command = (command === 'submit-add' ? '추가 ' : command === 'submit-playlist' ? '목록 ' : '검색 ') + song; }
    else if (command === 'submit-cancel') { var number = field('cancelNumber'); if (!/^[1-9][0-9]*$/.test(number)) return { text: '취소할 대기번호를 숫자로 입력해 주세요.' }; command = '취소 ' + number; }
    else if (!/^(메뉴|결과|일시정지|계속|다음|정지|재시도|취소 id:[a-f0-9-]{36})$/.test(command || '')) return { text: '지원하지 않는 버튼입니다. 새 메뉴를 열어 주세요.' };
    var at = e.eventTime || '', name = e.message && e.message.name || '';
    if (!at || !name) return { text: '요청을 확인하지 못했어요. 새 메뉴에서 다시 눌러 주세요.' };
    var response = onMessage({ eventTime: at, space: { name: space }, user: user, message: { name: space + '/messages/button-' + jbHash(name + '/' + user.name + '/' + at + '/' + command), argumentText: command, sender: user } });
    if (response.cardsV2) response.actionResponse = { type: 'NEW_MESSAGE' };
    return response;
  } catch (_) { return { text: '버튼을 처리하지 못했어요. @우사기 메뉴를 다시 열어 주세요.' }; }
}

// Fan-style interpretation: keep actionable status/error details after the character line.
function jbTone(kind, seed) {
  var lines = {
    connected: ['후웅~ 음악방이랑 통했어! 연결 상태는 아래!', '푸루! 우사기랑 연결 확인. 이제 같이 들어볼까?', '이~! 연결 소식 도착! 아래 상태를 봐 줘.'],
    received: ['푸루! 접수는 우사기한테 맡겨! ♪', '후웅~ 신청 받았어. 우사기가 살펴볼게!', '푸루야! 노래 배달 출발 준비~!'],
    playing: ['우라라라~!! 지금 이 곡이다! ♪', '야하~야핫! 음악 나오는 중! 신난다!', '푸루루루~♪ 우사기 음악방, 흔들흔들!'],
    added: ['우~라~! 플레이리스트가 통통해졌어!', '푸루야! 신청곡 줄 세우기, 우사기에게 맡겨!', '야핫! 이 곡도 챙겼다! ♪'],
    paused: ['후운~ 잠깐 쉬어가는 거구나. 우사기도 쪼그려 앉기!', '푸루. 일시정지 요청 받았어. 잠깐 숨 고르자!', '쥬르리… 쉬는 동안 간식 생각 중. 일시정지 요청!'],
    resumed: ['우라우라! 다시 달릴 준비~! 재생 계속 요청!', '푸루야! 쉬는 시간 끝. 재생 계속 요청했어!', '야하~야핫! 다시 듣자! 계속 재생 요청!'],
    next: ['우라우라! 다음 곡 쪽으로, 따라와~!', '푸루야! 다음 곡으로 폴짝!', '이~! 다음 곡도 여기 있다!'],
    stopped: ['하! 오늘 음악은 여기까지. 우사기도 쉬러 간다!', '후운~ 재생은 멈추고, 대기열도 싹 정리!', '푸루. 정리했어! 다음 음악회 때 또 만나!'],
    confirm: ['후웅? 재생을 멈추고 대기열까지 모두 비울까?', '하아? 전부 비우는 거야? 아래 확인 버튼을 눌러 줘!', '푸루? 정지는 확인 한 번만! 대기열도 같이 비워져.'],
    cancel: ['푸루. 신청 취소 확인! 이 곡은 줄에서 쏙!', '이~! 취소한 곡은 우사기가 챙겨 뺐어.', '후운~ 이 곡은 다음 기회에!'],
    error: ['하아?! 우사기도 깜짝! 아래 이유를 확인해 줘.', '후와~앙… 잠깐 막혔어. 아래 안내대로 다시 해보자!', '호와?! 이 요청은 지금 처리하기 어려워. 이유는 아래!'],
    menu: ['이~! 우사기 음악방 여기 봐! 링크를 넣고 골라 줘 ♡', '푸루야! 같이 듣자! 노래 신청은 아래 버튼으로!', '후웅~ 오늘은 뭘 들을까? 우사기한테 링크를 줘!'],
    empty: ['쥬르리… 노래도 간식처럼 기다리는 중! 첫 신청곡 어디 있지?', '후웅? 아직 조용하네. 좋아하는 노래를 데려와 줘!', '푸루야! 빈 음악방을 같이 채워보자!'],
    result: ['이~! 우사기가 확인한 결과, 여기 있어!', '후운~ 어떻게 됐는지 같이 볼까?', '푸루! 확인한 내용은 아래에 적어뒀어.']
  };
  var choices = lines[kind] || lines.result, hash = 0, text = String(seed || kind);
  for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return choices[hash % choices.length];
}
function jbSpeakResponse(response, seed) {
  if (!response || typeof response.text !== 'string' || /^(야하|야핫|우라|우~라|하아|하!|푸루|후웅|후운|후와|호와|쥬르리|이~)/.test(response.text)) return response;
  var text = response.text, kind = 'result';
  if (/링크를 붙여|버튼으로 신청|현재 음악방/.test(text)) kind = 'menu';
  if (/아직 처리 결과가 없|신청곡을 기다|현재: 없음.*대기: 없음/.test(text)) kind = 'empty';
  if (/^연결됨|^연결이 복구/.test(text)) kind = 'connected';
  if (/접수했습니다|이미 접수|재생 요청됨/.test(text)) kind = 'received';
  if (/대기열에 담/.test(text)) kind = 'added';
  if (/^재생 중(?:$|:)/.test(text)) kind = 'playing';
  if (/일시정지를 요청|일시정지됨|대기열이 일시정지/.test(text)) kind = 'paused';
  if (/재생 계속을 요청/.test(text)) kind = 'resumed';
  if (/다음 곡으로 이동/.test(text)) kind = 'next';
  if (/신청 취소:/.test(text)) kind = 'cancel';
  if (/재생을 멈추고 대기열을 비웠|대기열 비움 완료/.test(text)) kind = 'stopped';
  if (/비울까요/.test(text)) kind = 'confirm';
  if (/지원하지|허용되지|못했|오류|만료|차단|거부|설정이 필요|필요합니다|연결을 확인|유효한 HTTPS|입력하세요|입력해 주세요|올바르지|실패|운영자만|본인의 신청곡만|가득|개까지 신청/.test(text)) kind = 'error';
  // Receipts stay receipts; do not imply playback until the player has reported it.
  text = text.replace('접수했습니다. 보통 5~10초 안에 처리해요. 아래 결과 확인 버튼으로 진행 상황을 볼 수 있어요.', '신청 접수! 보통 5~10초 뒤 처리돼. 아직 재생 확인은 아니야. 아래에서 내 신청 결과 확인을 눌러 줘!')
    .replace('링크를 붙여 넣고 신청 버튼을 누르세요. 재생 제어와 결과 조회도 버튼으로 할 수 있어요.', '영상 링크는 신청하기, 재생목록 링크는 목록 담기! 재생 제어와 결과 확인도 아래 버튼으로 골라 줘.')
    .replace('버튼으로 신청하고 제어할 수 있어요. 아래에서 원하는 동작을 골라 주세요.', '우사기 호출 완료! 신청하기·목록 담기·재생 제어, 원하는 버튼을 콕 눌러 줘!');
  response.text = jbTone(kind, String(seed || '') + text) + '\n' + text;
  return response;
}
function onMessage(e) {
  var payload = e && e.chat && e.chat.messagePayload;
  var message = payload && payload.message || e && e.message;
  return jbPrivateResponse(jbSpeakResponse(jbHandleMessage(e), e && e.eventTime), e, message && message.sender);
}
function onCardClick(e) {
  var response = jbPrivateResponse(jbSpeakResponse(jbHandleClick(e), e && e.eventTime), e);
  if (response && response.privateMessageViewer) response.actionResponse = { type: 'NEW_MESSAGE' };
  return response;
}

// Dialog submissions never update the public launch card or echo the submitted link.
function jbPrivateResponse(response, e, sender) {
  if (!response || response.actionResponse && response.actionResponse.type === 'DIALOG') return response;
  var user = sender || e && (e.user || e.chat && e.chat.user || e.message && e.message.sender);
  if (user && user.type !== 'BOT' && /^users\/[A-Za-z0-9_-]+$/.test(user.name || '')) {
    response.privateMessageViewer = { name: user.name };
    if (response.actionResponse) response.actionResponse = { type: 'NEW_MESSAGE' };
    return response;
  }
  return {};
}
function jbDialogButton(label, command) {
  var button = jbButton(label, command);
  button.onClick.action.interaction = 'OPEN_DIALOG';
  return button;
}
function jbDialog(body) {
  body.sections.unshift({ widgets: [{ textParagraph: { text: '<b>🔒 나만 보임</b><br>이 창과 입력 내용은 다른 채팅방 멤버에게 보이지 않아.' } }] });
  return { actionResponse: { type: 'DIALOG', dialogAction: { dialog: { body: body } } } }; }
function jbDialogStatus(code, text) { return { actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: code, userFacingMessage: text.slice(0, 500) } } } }; }
function jbAnonymousDialog(e, command, field, space, user) {
  if (e.dialogEventType === 'CANCEL_DIALOG') return jbDialogStatus('OK', '푸루. 신청하지 않고 닫았어.');
  if (command === 'open-anonymous' || command === 'open-private-result') {
    if (e.dialogEventType !== 'REQUEST_DIALOG') return { text: '새 메뉴의 비공개 신청창 버튼을 눌러 줘.' };
    if (command === 'open-private-result') {
      var result = jbRead(jbProps(), 'r_' + jbHash(space + '/' + user.name), null);
      var message = result && Date.now() - result.at < 86400000 ? result.text : '아직 처리 결과가 없어. 신청 후 보통 5~10초 뒤 다시 열어 줘!';
      var widgets = [{ textParagraph: { text: jbHtml(jbSpeakResponse({ text: message }).text) } }];
      if (result && result.search && result.search.expiresAt > Date.now()) {
        widgets = widgets.concat(jbResultChoices(result.search, 'anonymous-pick:'));
      }
      return jbDialog({ sections: [{ header: '내 신청 결과 · 본인만 표시', widgets: widgets }] });
    }
    var view = jbRead(jbProps(), 'VIEW', null);
    var buttons = [jbButton('한 곡 신청', 'anonymous-add', 'privateSong'), jbButton('♫ 목록 담기', 'anonymous-playlist', 'privateSong')];
    if (view && view.searchEnabled) buttons.push(jbButton('곡명 검색', 'anonymous-search', 'privateSong'));
    return jbDialog({ sections: [{ header: '우사기 비공개 신청창', widgets: [
      { textParagraph: { text: '푸루야! 공용 플리에는 곡만 표시돼.' } },
      { textInput: { name: 'privateSong', label: view && view.searchEnabled ? 'YouTube 링크 또는 검색할 곡명' : 'YouTube 영상·재생목록 링크', hintText: view && view.searchEnabled ? '곡명은 곡명 검색 → 내 신청 결과에서 골라 줘!' : '채팅창에 보내지 말고 여기에 붙여 넣어 줘!', type: 'SINGLE_LINE' } },
      { buttonList: { buttons: buttons } }
    ] }] });
  }
  if (e.dialogEventType !== 'SUBMIT_DIALOG' || !/^anonymous-(add|playlist|search)$/.test(command || '')) return { text: '지원하지 않는 비공개 신청입니다. 새 신청창을 열어 줘.' };
  var song = field('privateSong');
  if (!song || song.length > 300) return jbDialogStatus('INVALID_ARGUMENT', '하아? 링크 또는 곡명을 1~300자로 입력해 줘!');
  if (!e.eventTime || !e.message || !e.message.name) return jbDialogStatus('INVALID_ARGUMENT', '요청을 확인하지 못했어. 새 신청창을 열어 줘.');
  if (command === 'anonymous-search' && !jbRead(jbProps(), 'VIEW', {}).searchEnabled) return jbDialogStatus('INVALID_ARGUMENT', '검색 준비 중이야. 지금은 YouTube 링크로 신청해 줘!');
  var verb = { 'anonymous-add': '추가', 'anonymous-playlist': '목록', 'anonymous-search': '검색' }[command];
  var request = { eventTime: e.eventTime, space: { name: space }, user: user, message: { name: space + '/messages/private-' + jbHash(e.message.name + '/' + user.name + '/' + e.eventTime + '/' + command + '/' + song), argumentText: verb + ' ' + song, sender: user } };
  var result = jbHandleMessage(request), accepted = /접수했습니다|이미 접수/.test(result.text || '');
  return jbDialogStatus(accepted ? 'OK' : 'INVALID_ARGUMENT', accepted ? '푸루! 비공개로 접수했어. 아직 재생 확인은 아니야. 잠시 후 내 신청 결과 · 비공개에서 확인해 줘!' : String(result.text || '신청을 확인하지 못했어.'));
}

function jbResultChoices(search, prefix) {
  return search.titles.map(function(title, index) {
    return { decoratedText: { text: jbHtml(title), wrapText: true,
      button: jbButton('＋ 신청', prefix + search.selectionId + ':' + (index + 1)) } };
  });
}

function jbPickLatestResult(e, command, space, user) {
  var match = /^(result-pick|anonymous-pick):([a-f0-9-]{36}):([1-5])$/.exec(command);
  var dialog = e.dialogEventType === 'SUBMIT_DIALOG';
  var result = jbRead(jbProps(), 'r_' + jbHash(space + '/' + user.name), {});
  var search = result.search;
  if (!match || (match[1] === 'anonymous-pick') !== dialog || !search ||
      search.selectionId !== match[2] || search.expiresAt <= Date.now() ||
      !search.titles[Number(match[3]) - 1] || !e.eventTime || !e.message || !e.message.name) {
    var message = '이 검색 결과는 만료됐어. 최신 검색 결과를 다시 열어 줘.';
    return dialog ? jbDialogStatus('INVALID_ARGUMENT', message) : { text: message };
  }
  var reply = jbHandleMessage({
    eventTime: e.eventTime, space: { name: space }, user: user, jukeboxDialog: true, jukeboxSelectionId: match[2],
    message: { name: space + '/messages/result-pick-' + jbHash(user.name + '/' + match[2] + '/' + match[3]), argumentText: '선택 ' + match[3], sender: user }
  });
  var text = reply.accepted ? '푸루! 신청을 접수했어. 내 신청 결과에서 확인해 줘.' : reply.text;
  return dialog ? jbDialogStatus(reply.accepted ? 'OK' : 'INVALID_ARGUMENT', text) : { text: text };
}

function jbDialogForm(title, input, label, command, multiline) {
  return jbDialog({ sections: [{ header: title, widgets: [
    { textInput: { name: input, label: label, type: multiline ? 'MULTIPLE_LINE' : 'SINGLE_LINE' } },
    { buttonList: { buttons: [jbButton(multiline ? '요청 보내기' : '검색', command, input)] } }
  ] }] });
}

function jbFeedbackDialog(e, command, field, space, user) {
  if (e.dialogEventType === 'CANCEL_DIALOG') return jbDialogStatus('OK', '푸루. 창을 닫았어.');
  if (command === 'feedback-open' && e.dialogEventType === 'REQUEST_DIALOG') {
    return jbDialogForm('개발자에게 기능 요청', 'feedbackText', '추가하고 싶은 기능이나 불편했던 점 (최대 500자)', 'feedback-submit', true);
  }
  var idea = field('feedbackText');
  if (command !== 'feedback-submit' || e.dialogEventType !== 'SUBMIT_DIALOG' || !idea || idea.length > 500 || !e.message || !e.message.name || !e.eventTime) {
    return jbDialogStatus('INVALID_ARGUMENT', '요청 내용을 1~500자로 입력해 줘.');
  }
  var at = Date.parse(e.eventTime), now = Date.now();
  if (!isFinite(at) || now - at > JB_TTL || at - now > 60000) return jbDialogStatus('INVALID_ARGUMENT', '요청 시간이 지났어. 창을 다시 열어 줘.');
  return jbLocked(function(p) {
    if (!jbRead(p, 'FEEDBACK_OPERATORS', []).length) return jbDialogStatus('UNAVAILABLE', '요청함을 준비하는 중이야. 잠시 후 다시 시도해 줘.');
    var id = jbHash(space + '/' + user.name + '/' + e.message.name + '/' + e.eventTime);
    if (p.getProperty('fb_' + id)) return jbDialogStatus('OK', '푸루! 개발자 요청함에 남겼어.');
    var ids = jbIndex(p, 'FEEDBACK', 'fb_', 30 * 86400000, now);
    var recent = ids.some(function(key) {
      var request = jbRead(p, 'fb_' + key, {});
      return request.user === user.name && request.space === space && now - request.at < 60000;
    });
    if (recent) return jbDialogStatus('RESOURCE_EXHAUSTED', '기능 요청은 1분 간격으로 보낼 수 있어.');
    jbRemember(p, 'FEEDBACK', 'fb_', id, { at: now, space: space, user: user.name, text: idea }, 50, 30 * 86400000, now);
    return jbDialogStatus('OK', '푸루! 개발자 요청함에 남겼어.');
  });
}

function jbFeedbackInbox(p, space, user) {
  if (jbRead(p, 'FEEDBACK_OPERATORS', []).indexOf(user) < 0) return { text: '기능 요청함은 운영자만 볼 수 있어.' };
  var entries = jbIndex(p, 'FEEDBACK', 'fb_', 30 * 86400000, Date.now()).map(function(id) {
    return jbRead(p, 'fb_' + id, null);
  }).filter(function(entry) { return entry && entry.space === space; }).slice(-10).reverse();
  var widgets = entries.map(function(entry) {
    return { textParagraph: { text: jbHtml(new Date(entry.at).toISOString().slice(0, 10) + '\n' + entry.text) } };
  });
  if (!widgets.length) widgets.push({ textParagraph: { text: '아직 접수된 기능 요청이 없어.' } });
  return { text: '이~! 최근 10건을 모았어. 요청은 최대 30일 동안 보관해.', cardsV2: [
    { cardId: 'feedback-inbox', card: { sections: [{ header: '개발자 기능 요청함', widgets: widgets }] } }
  ] };
}

function jbSearchDialog(e, command, field, space, user) {
  if (e.dialogEventType === 'CANCEL_DIALOG') return jbDialogStatus('OK', '푸루. 검색창을 닫았어.');
  if (command === 'search-open' && e.dialogEventType === 'REQUEST_DIALOG' || command === 'search-again' && e.dialogEventType === 'SUBMIT_DIALOG') {
    if (!jbRead(jbProps(), 'VIEW', {}).searchEnabled) return jbDialogStatus('UNAVAILABLE', '지금은 링크로 신청해 줘.');
    return jbDialogForm('우사기 곡 검색 · 비공개', 'searchSong', '곡명 또는 가수', 'search-submit', false);
  }
  if (e.dialogEventType !== 'SUBMIT_DIALOG' || !e.eventTime || !e.message || !e.message.name) {
    return jbDialogStatus('INVALID_ARGUMENT', '새 메뉴에서 곡 검색을 열어 줘.');
  }
  if (command === 'search-submit') {
    var query = field('searchSong');
    if (!query || query.length > 300) return jbDialogStatus('INVALID_ARGUMENT', '곡명이나 가수를 1~300자로 입력해 줘.');
    if (!jbRead(jbProps(), 'VIEW', {}).searchEnabled) return jbDialogStatus('UNAVAILABLE', '지금은 링크로 신청해 줘.');
    var name = space + '/messages/search-' + jbHash(e.message.name + '/' + user.name + '/' + e.eventTime + '/' + query);
    var id = jbHash(name);
    jbLocked(function(p) {
      if (!p.getProperty('sp_' + id)) jbRemember(p, 'SEARCH_DIALOGS', 'sp_', id, { at: Date.now(), space: space, user: user.name }, 50, JB_TTL, Date.now());
    });
    var result = jbHandleMessage({
      eventTime: e.eventTime, space: { name: space }, user: user, jukeboxDialog: true,
      message: { name: name, argumentText: '검색 ' + query, sender: user }
    });
    if (!result.accepted) return jbDialogStatus('INVALID_ARGUMENT', result.text || '검색을 접수하지 못했어.');
    return jbSearchResultDialog(jbProps(), id, space, user.name);
  }
  var parts = /^search-(check|pick):([a-f0-9]{64})(?::([1-5]))?$/.exec(command || '');
  if (!parts || (parts[1] === 'pick') !== !!parts[3]) return jbDialogStatus('INVALID_ARGUMENT', '검색창을 다시 열어 줘.');
  if (parts[1] === 'check') return jbSearchResultDialog(jbProps(), parts[2], space, user.name);
  var record = jbRead(jbProps(), 'sp_' + parts[2], {});
  if (record.user !== user.name || record.space !== space || !record.search || record.search.expiresAt <= Date.now() || !record.search.titles[Number(parts[3]) - 1]) {
    return jbDialogStatus('INVALID_ARGUMENT', '검색 결과가 만료됐어. 다시 검색해 줘.');
  }
  var picked = jbHandleMessage({
    eventTime: e.eventTime, space: { name: space }, user: user, jukeboxDialog: true, jukeboxSelectionId: record.search.selectionId,
    message: { name: space + '/messages/pick-' + jbHash(parts[2] + '/' + parts[3]), argumentText: '선택 ' + parts[3], sender: user }
  });
  return jbDialogStatus(picked.accepted ? 'OK' : 'INVALID_ARGUMENT', picked.accepted ? '푸루! 신청을 접수했어. 대기열에 담겼는지는 내 신청 결과에서 확인해 줘.' : picked.text);
}

function jbSearchResultDialog(p, id, space, user) {
  var result = jbRead(p, 'sp_' + id, {});
  // Keep this submission open while the laptop works. Never hold the bridge
  // lock here: the worker needs it to publish the result.
  var deadline = Date.now() + 5600;
  while (result.space === space && result.user === user &&
      !result.search && !result.text && Date.now() - result.at < JB_TTL && Date.now() < deadline) {
    var wait = Math.min(250, deadline - Date.now());
    if (wait <= 0) break;
    Utilities.sleep(wait);
    result = jbRead(p, 'sp_' + id, {});
  }
  var widgets = [], buttons = [jbButton('다시 검색', 'search-again')];
  var status = '검색 결과가 만료됐어. 다시 검색해 줘.';
  if (result.space === space && result.user === user && Date.now() - result.at < JB_TTL) {
    if (result.search && result.search.expiresAt > Date.now()) {
      status = '야핫! 듣고 싶은 곡 옆의 신청을 눌러 줘.';
      result.search.titles.forEach(function(title, index) {
        widgets.push({ decoratedText: {
          text: jbHtml(title), wrapText: true,
          button: jbButton('＋ 신청', 'search-pick:' + id + ':' + (index + 1))
        } });
      });
    } else if (result.text && !result.search) {
      status = result.text;
    } else if (!result.text) {
      status = '후운… 음악방 응답이 늦어. 같은 검색을 다시 확인하거나 새로 검색해 줘.';
      buttons.unshift(jbButton('다시 시도', 'search-check:' + id));
    }
  }
  widgets.unshift({ textParagraph: { text: jbHtml(status) } });
  widgets.push({ buttonList: { buttons: buttons } });
  return jbDialog({ sections: [{ header: '우사기 곡 검색 · 비공개', widgets: widgets }] });
}
