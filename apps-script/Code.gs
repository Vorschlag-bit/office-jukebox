/* No OAuth scopes, external requests, triggers, billing or service-account keys. */
var JB_TTL = 300000;
function jbProps() { return PropertiesService.getScriptProperties(); }
function jbHash(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function jbRead(p, k, fallback) { var v = p.getProperty(k); return v ? JSON.parse(v) : fallback; }
function jbWrite(p, k, v) { p.setProperty(k, JSON.stringify(v)); }
function jbSpaces(p) { var a = jbRead(p, 'ALLOWED_SPACES', []); if (!Array.isArray(a) || a.length > 10 || a.some(function(s) { return !/^spaces\/[A-Za-z0-9_-]+$/.test(s); })) throw Error('CONFIG'); return a; }
function jbLocked(f) { var l = LockService.getScriptLock(); if (!l.tryLock(1000)) throw Error('BUSY'); try { return f(jbProps()); } finally { l.releaseLock(); } }
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
function onAddedToSpace() { return { text: 'Office Jukebox: @앱 내정보 → 허용 목록 설정 → @앱 추가 <유튜브 URL> → 잠시 후 @앱 결과. 노트북 서버가 필요합니다.' }; }
function onMessage(e) {
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
      if (['메뉴', 'menu', '도움말', '명령어', 'help'].indexOf(text) >= 0) return jbPanel(p, space, u.name, '링크를 붙여 넣고 신청 버튼을 누르세요. 재생 제어와 결과 조회도 버튼으로 할 수 있어요.');
      if (['상태', 'status', '대기열', 'queue'].indexOf(text) >= 0 && p.getProperty('VIEW')) return jbPanel(p, space, u.name, '현재 음악방 상태입니다.');
      if (text === '결과') {
        var r = jbRead(p, 'r_' + jbHash(space + '/' + u.name), null);
        return jbPanel(p, space, u.name, r && Date.now() - r.at < 86400000 ? jbSafe(r.text) + '\n[노트북 처리 결과: ' + new Date(r.at).toISOString() + ']' : '아직 처리 결과가 없어요. 신청 후 잠시 기다렸다 결과 확인을 눌러 주세요.');
      }
      var verb = text.split(/\s+/)[0].toLowerCase();
      if (['추가','재생','add','play','검색','search','선택','select','취소','cancel','대기열','queue','상태','status','일시정지','pause','계속','resume','다음','next','정지','stop','재시도','retry','확인','confirm'].indexOf(verb) < 0) return jbPanel(p, space, u.name, '버튼으로 신청하고 제어할 수 있어요. 아래에서 원하는 동작을 골라 주세요.');
      var now = Date.now(), eventAt = Date.parse(e.eventTime || (e.chat && e.chat.eventTime) || m.createTime || '');
      if (!isFinite(eventAt) || now - eventAt > JB_TTL || eventAt - now > 60000) return { text: '만료되었거나 시간이 잘못된 요청입니다. 새 명령을 보내세요.' };
      var secret = p.getProperty('SHARED_SECRET');
      if (!secret || secret.length < 32) return { text: 'SHARED_SECRET 설정이 필요합니다.' };
      var id = jbHash(m.name);
      if (p.getProperty('s_' + id)) return { text: '이미 접수한 요청입니다. 결과 명령으로 확인하세요.' };
      var ids = jbIndex(p, 'QUEUE', 'q_', JB_TTL, now);
      if (ids.length >= 50) return { text: '중계 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.' };
      var record = { id: id, text: text, space: space, user: u.name, at: eventAt };
      // Save command before dedup marker: an interrupted handler must not silently lose it.
      jbWrite(p, 'q_' + id, record); if (ids.indexOf(id) < 0) ids.push(id); jbWrite(p, 'QUEUE', ids);
      jbRemember(p, 'SEEN', 's_', id, { at: now }, 100, 86400000, now);
      return jbPanel(p, space, u.name, '접수했습니다. 보통 5~10초 안에 처리해요. 아래 결과 확인 버튼으로 진행 상황을 볼 수 있어요.');
    });
  } catch (_) { return { text: '중계가 일시 중단되었습니다. 잠시 후 재시도하거나 Apps Script 설정·할당량을 확인하세요.' }; }
}
function doPost(e) {
  var result;
  try {
    var body = e && e.postData && e.postData.contents;
    if (typeof body !== 'string' || body.length > 16000) throw Error('BODY');
    var r = JSON.parse(body), now = Date.now();
    if (r.v !== 1 || !Number.isFinite(r.ts) || Math.abs(now-r.ts) > 60000 || !/^[a-zA-Z0-9_-]{16,80}$/.test(r.nonce || '') || ['check','pull','ack','result'].indexOf(r.op) < 0 || typeof r.payload !== 'string' || r.payload.length > 10000 || !/^[a-f0-9]{64}$/.test(r.signature || '')) throw Error('AUTH');
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
          jbRemember(p, 'RESULTS', 'r_', jbHash(d.space+'/'+d.user), { at: now, text: d.text }, 50, 86400000, now);
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
        if (d.view && Array.isArray(d.view.queue) && d.view.queue.length <= 8 && Number.isInteger(d.view.queueCount) && d.view.queueCount >= 0 && d.view.queueCount <= 500 && typeof d.view.paused === 'boolean' && typeof d.view.searchEnabled === 'boolean' && d.view.queue.every(function(x) { return x && typeof x.title === 'string' && x.title.length <= 180; }) && (!d.view.current || (typeof d.view.current.title === 'string' && d.view.current.title.length <= 180 && typeof d.view.current.status === 'string' && d.view.current.status.length <= 30))) { jbWrite(p, 'VIEW', { at: now, current: d.view.current, queue: d.view.queue, queueCount: d.view.queueCount, paused: d.view.paused, searchEnabled: d.view.searchEnabled, playerOnline: !!d.view.playerOnline }); }
        if (!ids.length) return { ok:true,command:null };
        var c = jbRead(p,'q_'+ids[0],null);
        if (c.until > now) return { ok:true,command:null };
        c.lease = Utilities.getUuid(); c.until = now+30000; jbWrite(p,'q_'+c.id,c);
        return { ok:true,command:c };
      }
      var c = jbRead(p,'q_'+d.id,null);
      if (c && (c.lease !== d.lease || c.until < now)) throw Error('LEASE');
      if (c) { jbWrite(p,'QUEUE',ids.filter(function(id) { return id !== d.id; })); p.deleteProperty('q_'+d.id); }
      return { ok:true };
    });
  } catch (_) { result = { ok:false, error:'BRIDGE_REJECTED' }; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function jbHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); }
function jbButton(label, command, required) {
  var action = { function: 'onCardClick', parameters: [{ key: 'command', value: command }] };
  if (required) action.requiredWidgets = [required];
  return { text: label, onClick: { action: action } };
}
function jbPanel(p, space, user, message) {
  var view = jbRead(p, 'VIEW', null), fresh = view && Date.now() - view.at < 30000;
  var statusNames = { playing: '재생 중', paused: '일시정지', blocked: '화면에서 재생 허용이 필요해요', sent_unconfirmed: '재생 준비 중', dispatching: '재생 준비 중', error: '재생 오류 · 다시 재생 또는 다음 곡', recovery_required: '서버가 복구됐어요 · 다시 재생을 눌러 주세요' };
  var widgets = [];
  if (view) {
    var summary = fresh ? (view.current ? '♫ ' + view.current.title + '\n' + (statusNames[view.current.status] || view.current.status) : '♫ 첫 곡을 기다리고 있어요') : '노트북 연결이 잠시 끊겼어요. 서버가 켜져 있는지 확인해 주세요.';
    if (view.paused) summary += '\n대기열 일시정지 · 계속 버튼으로 다시 시작';
    summary += '\n\n다음 곡 ' + view.queueCount + '개' + (view.queue.length ? '' : ' · 비어 있어요');
    if (view.queueCount > view.queue.length) summary += '\n외 ' + (view.queueCount-view.queue.length) + '곡';
    widgets.push({ textParagraph: { text: jbHtml(summary) } });
  }
  widgets.push({ buttonList: { buttons: [jbButton('↻ 상태 새로고침', '메뉴'), jbButton('내 신청 결과 확인', '결과')] } });
  var sections = [{ widgets: widgets }, { header: '노래 신청', widgets: [
    { textInput: { name: 'song', label: view && view.searchEnabled ? 'YouTube 링크 또는 곡명' : 'YouTube 영상 링크', hintText: 'YouTube → 공유 → 링크 복사', type: 'SINGLE_LINE' } },
    { buttonList: { buttons: view && view.searchEnabled ? [jbButton('＋ 신청하기', 'submit-add', 'song'), jbButton('검색해서 고르기', 'submit-search', 'song')] : [jbButton('＋ 신청하기', 'submit-add', 'song')] } }
  ] }];
  var result = jbRead(p, 'r_' + jbHash(space + '/' + user), null);
  if (result && Date.now() - result.at < 300000 && /5분 이내에 선택/.test(result.text)) {
    var options = result.text.split('\n').filter(function(line) { return /^[1-5]\. /.test(line); });
    if (options.length) sections.push({ header: '검색 결과에서 고르기', widgets: options.map(function(line) { return { buttonList: { buttons: [jbButton(line.slice(0, 70) + ' ＋ 신청', '선택 ' + line.charAt(0))] } }; }) });
  }
  var paused = view && (view.paused || view.current && view.current.status === 'paused');
  var controls = [jbButton(paused ? '▶ 계속 재생' : 'Ⅱ 일시정지', paused ? '계속' : '일시정지'), jbButton('⏭ 다음 곡', '다음'), jbButton('정지 · 비우기', 'confirm-stop')];
  if (view && view.current && ['error', 'recovery_required'].indexOf(view.current.status) >= 0) controls.unshift(jbButton('다시 재생', '재시도'));
  sections.push({ header: '재생 제어 · 운영자', widgets: [{ buttonList: { buttons: controls } }] });
  if (view && view.queue.length) sections.push({ header: '다음 곡 · 취소할 곡을 누르세요', widgets: view.queue.map(function(song, i) {
    if (/^[a-f0-9-]{36}$/.test(song.id || '')) return { buttonList: { buttons: [jbButton((i+1) + '. ' + song.title.slice(0, 55) + '  × 취소', '취소 id:' + song.id)] } };
    return { textParagraph: { text: jbHtml((i+1) + '. ' + song.title) } };
  }) });
  return { text: message, cardsV2: [{ cardId: 'jukebox-menu', card: { header: { title: '주크봇 음악방', subtitle: '신청은 간단하게, 음악은 함께', imageUrl: 'https://raw.githubusercontent.com/Vorschlag-bit/office-jukebox/13372d5993a41d405521e5d24e2a642125c757a1/public/avatar.png', imageType: 'CIRCLE' }, sections: sections } }] };
}
function onCardClick(e) {
  try {
    var common = e.common || e.commonEventObject || {}, parameters = common.parameters || {};
    (e.action && e.action.parameters || []).forEach(function(x) { parameters[x.key] = x.value; });
    var command = parameters.command, inputs = common.formInputs || e.formInputs || {};
    function field(name) { var x = inputs[name]; x = x && (x[''] || x); return x && x.stringInputs && x.stringInputs.value && String(x.stringInputs.value[0] || '').trim() || ''; }
    var space = e.space && e.space.name || e.message && e.message.space && e.message.space.name, user = e.user || {};
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(space || '') || !/^users\/[A-Za-z0-9_-]+$/.test(user.name || '') || user.type === 'BOT') return { text: '지원하지 않는 이벤트입니다.' };
    if (jbSpaces(jbProps()).indexOf(space) < 0) return { text: '허용되지 않은 스페이스입니다.' };
    if (command === 'confirm-stop') return { actionResponse: { type: 'UPDATE_MESSAGE' }, text: '재생을 멈추고 대기열을 모두 비울까요?', cardsV2: [{ cardId: 'confirm-stop', card: { sections: [{ widgets: [{ buttonList: { buttons: [jbButton('돌아가기', '메뉴'), jbButton('정지하고 모두 비우기', '정지')] } }] }] } }] };
    if (command === 'submit-add' || command === 'submit-search') { var song = field('song'); if (!song || song.length > 300) return { text: 'YouTube 영상 링크 또는 곡명을 입력해 주세요. 최대 300자입니다.' }; command = (command === 'submit-add' ? '추가 ' : '검색 ') + song; }
    else if (command === 'submit-cancel') { var number = field('cancelNumber'); if (!/^[1-9][0-9]*$/.test(number)) return { text: '취소할 대기번호를 숫자로 입력해 주세요.' }; command = '취소 ' + number; }
    else if (!/^(메뉴|결과|일시정지|계속|다음|정지|재시도|선택 [1-5]|취소 id:[a-f0-9-]{36})$/.test(command || '')) return { text: '지원하지 않는 버튼입니다. 새 메뉴를 열어 주세요.' };
    var at = e.eventTime || '', name = e.message && e.message.name || '';
    if (!at || !name) return { text: '요청을 확인하지 못했어요. 새 메뉴에서 다시 눌러 주세요.' };
    var response = onMessage({ eventTime: at, space: { name: space }, user: user, message: { name: space + '/messages/button-' + jbHash(name + '/' + user.name + '/' + at + '/' + command), argumentText: command, sender: user } });
    if (response.cardsV2) response.actionResponse = { type: 'UPDATE_MESSAGE' };
    return response;
  } catch (_) { return { text: '버튼을 처리하지 못했어요. @주크봇 메뉴를 다시 열어 주세요.' }; }
}
