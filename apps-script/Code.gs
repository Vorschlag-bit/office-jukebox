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
function onAddedToSpace() { return jbSpeakResponse({ text: '우사기 등장! 운영자는 @우사기 익명메뉴를 보내 공용 신청 버튼을 띄워 줘. 선곡은 비공개 신청창에 넣어 줘!' }); }
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
      if (text === '익명메뉴') return jbPanel(p, space, '', '푸루야! 선곡자는 다른 참여자에게 표시하지 않아. 신청은 아래 비공개 신청창에서!');
      if (['메뉴', 'menu', '도움말', '명령어', 'help'].indexOf(text) >= 0) return jbPanel(p, space, u.name, '링크를 붙여 넣고 신청 버튼을 누르세요. 재생 제어와 결과 조회도 버튼으로 할 수 있어요.');
      if (['상태', 'status', '대기열', 'queue'].indexOf(text) >= 0 && p.getProperty('VIEW')) return jbPanel(p, space, u.name, '현재 음악방 상태입니다.');
      if (text === '결과') {
        var r = jbRead(p, 'r_' + jbHash(space + '/' + u.name), null);
        return jbPanel(p, space, u.name, r && Date.now() - r.at < 86400000 ? jbSafe(r.text) + '\n[노트북 처리 결과: ' + new Date(r.at).toISOString() + ']' : '아직 처리 결과가 없어요. 신청 후 잠시 기다렸다 결과 확인을 눌러 주세요.');
      }
      var verb = text.split(/\s+/)[0].toLowerCase();
      if (['목록','재생목록','playlist','추가','재생','add','play','검색','search','선택','select','취소','cancel','대기열','queue','상태','status','일시정지','pause','계속','resume','다음','next','정지','stop','재시도','retry','확인','confirm'].indexOf(verb) < 0) return jbPanel(p, space, u.name, '버튼으로 신청하고 제어할 수 있어요. 아래에서 원하는 동작을 골라 주세요.');
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
  var statusNames = { playing: '재생 중 · 우라라라~♪', paused: '일시정지 · 후운~ 쉬어가자', blocked: '화면에서 재생 허용이 필요해요', sent_unconfirmed: '재생 준비 중', dispatching: '재생 준비 중', error: '재생 오류 · 다시 재생 또는 다음 곡', recovery_required: '서버가 복구됐어요 · 다시 재생을 눌러 주세요' };
  var widgets = [];
  if (view) {
    var summary = fresh ? (view.current ? '♫ ' + view.current.title + '\n' + (statusNames[view.current.status] || view.current.status) : '쥬르리… 첫 신청곡을 기다리는 중!') : '노트북 연결이 잠시 끊겼어요. 서버가 켜져 있는지 확인해 주세요.';
    if (view.paused) summary += '\n대기열 일시정지 · 계속 버튼으로 다시 시작';
    summary += '\n\n다음 곡 ' + view.queueCount + '개' + (view.queue.length ? '' : ' · 비어 있어요');
    if (view.queueCount > view.queue.length) summary += '\n외 ' + (view.queueCount-view.queue.length) + '곡';
    widgets.push({ textParagraph: { text: jbHtml(summary) } });
  }
  widgets.push({ buttonList: { buttons: [jbButton('↻ 상태 새로고침', '메뉴'), jbButton('내 신청 결과 확인', '결과')] } });
  var sections = [{ widgets: widgets }, { header: '선곡자는 숨기고, 음악은 함께!', widgets: [
    { textParagraph: { text: '신청 링크는 채팅창에 직접 보내지 말고 아래 비공개 신청창에 넣어 줘. 창과 결과는 본인만 볼 수 있어. 공용 화면에는 곡만 표시해!<br><br>Google과 봇 운영자는 내부 식별 정보를 처리할 수 있어. 완전한 추적 불가능 익명은 아니야.' } },
    { buttonList: { buttons: [jbDialogButton('비공개 신청창 열기', 'open-anonymous'), jbDialogButton('내 신청 결과 · 비공개', 'open-private-result')] } }
  ] }];
  var result = jbRead(p, 'r_' + jbHash(space + '/' + user), null);
  if (user && result && Date.now() - result.at < 300000 && /5분 이내에 선택/.test(result.text)) {
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
  return { text: message, cardsV2: [{ cardId: 'jukebox-menu', card: { header: { title: '우사기 음악방', subtitle: jbTone('menu', message), imageUrl: 'https://raw.githubusercontent.com/Vorschlag-bit/office-jukebox/13372d5993a41d405521e5d24e2a642125c757a1/public/avatar.png', imageType: 'CIRCLE' }, sections: sections } }] };
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
    if (e.dialogEventType || /^(open-anonymous|open-private-result|anonymous-)/.test(command || '')) return jbAnonymousDialog(e, command, field, space, user);
    if (command === 'confirm-stop') return { actionResponse: { type: 'UPDATE_MESSAGE' }, text: '재생을 멈추고 대기열을 모두 비울까요?', cardsV2: [{ cardId: 'confirm-stop', card: { sections: [{ widgets: [{ buttonList: { buttons: [jbButton('돌아가기', '메뉴'), jbButton('정지하고 모두 비우기', '정지')] } }] }] } }] };
    if (command === 'submit-add' || command === 'submit-search' || command === 'submit-playlist') { var song = field('song'); if (!song || song.length > 300) return { text: 'YouTube 영상 링크 또는 곡명을 입력해 주세요. 최대 300자입니다.' }; command = (command === 'submit-add' ? '추가 ' : command === 'submit-playlist' ? '목록 ' : '검색 ') + song; }
    else if (command === 'submit-cancel') { var number = field('cancelNumber'); if (!/^[1-9][0-9]*$/.test(number)) return { text: '취소할 대기번호를 숫자로 입력해 주세요.' }; command = '취소 ' + number; }
    else if (!/^(메뉴|결과|일시정지|계속|다음|정지|재시도|선택 [1-5]|취소 id:[a-f0-9-]{36})$/.test(command || '')) return { text: '지원하지 않는 버튼입니다. 새 메뉴를 열어 주세요.' };
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
  var response = jbSpeakResponse(jbHandleMessage(e), e && e.eventTime);
  var text = e && e.message && (e.message.argumentText || e.message.text) || '';
  return /^\/?익명메뉴$/.test(text.trim()) ? response : jbPrivateResponse(response, e);
}
function onCardClick(e) { return jbPrivateResponse(jbSpeakResponse(jbHandleClick(e), e && e.eventTime), e); }

// Dialog submissions never update the public launch card or echo the submitted link.
function jbPrivateResponse(response, e) {
  if (!response || response.actionResponse && response.actionResponse.type === 'DIALOG') return response;
  var payload = e && e.chat && e.chat.messagePayload;
  var user = e && e.user || payload && payload.message && payload.message.sender || e && e.message && e.message.sender;
  if (user && user.type !== 'BOT' && /^users\/[A-Za-z0-9_-]+$/.test(user.name || '')) {
    response.privateMessageViewer = { name: user.name };
    if (response.actionResponse) response.actionResponse.type = 'NEW_MESSAGE';
  }
  return response;
}
function jbDialogButton(label, command) {
  var button = jbButton(label, command);
  button.onClick.action.interaction = 'OPEN_DIALOG';
  return button;
}
function jbDialog(body) { return { actionResponse: { type: 'DIALOG', dialogAction: { dialog: { body: body } } } }; }
function jbDialogStatus(code, text) { return { actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: code, userFacingMessage: text.slice(0, 500) } } } }; }
function jbAnonymousDialog(e, command, field, space, user) {
  if (e.dialogEventType === 'CANCEL_DIALOG') return jbDialogStatus('OK', '푸루. 신청하지 않고 닫았어.');
  if (command === 'open-anonymous' || command === 'open-private-result') {
    if (e.dialogEventType !== 'REQUEST_DIALOG') return { text: '새 메뉴의 비공개 신청창 버튼을 눌러 줘.' };
    if (command === 'open-private-result') {
      var result = jbRead(jbProps(), 'r_' + jbHash(space + '/' + user.name), null);
      var message = result && Date.now() - result.at < 86400000 ? result.text : '아직 처리 결과가 없어. 신청 후 보통 5~10초 뒤 다시 열어 줘!';
      return jbDialog({ sections: [{ header: '내 신청 결과 · 본인만 표시', widgets: [{ textParagraph: { text: jbHtml(jbSpeakResponse({ text: message }).text) } }] }] });
    }
    var view = jbRead(jbProps(), 'VIEW', null);
    var buttons = [jbButton('한 곡 신청', 'anonymous-add', 'privateSong'), jbButton('♫ 목록 담기', 'anonymous-playlist', 'privateSong')];
    if (view && view.searchEnabled) buttons.push(jbButton('곡명 검색', 'anonymous-search', 'privateSong'));
    return jbDialog({ sections: [{ header: '우사기 비공개 신청창', widgets: [
      { textParagraph: { text: '푸루야! 이 창과 입력 내용은 다른 참여자에게 안 보여. 신청 결과도 비공개로 확인해 줘.<br>공용 화면에는 곡이 표시돼. Google·봇 운영자는 내부 식별 정보를 처리할 수 있어.' } },
      { textInput: { name: 'privateSong', label: 'YouTube 영상·재생목록 링크', hintText: '채팅창에 보내지 말고 여기에 붙여 넣어 줘!', type: 'SINGLE_LINE' } },
      { buttonList: { buttons: buttons } }
    ] }] });
  }
  if (e.dialogEventType !== 'SUBMIT_DIALOG' || !/^anonymous-(add|playlist|search)$/.test(command || '')) return { text: '지원하지 않는 비공개 신청입니다. 새 신청창을 열어 줘.' };
  var song = field('privateSong');
  if (!song || song.length > 300) return jbDialogStatus('INVALID_ARGUMENT', '하아? 링크 또는 곡명을 1~300자로 입력해 줘!');
  if (!e.eventTime || !e.message || !e.message.name) return jbDialogStatus('INVALID_ARGUMENT', '요청을 확인하지 못했어. 새 신청창을 열어 줘.');
  var verb = { 'anonymous-add': '추가', 'anonymous-playlist': '목록', 'anonymous-search': '검색' }[command];
  var request = { eventTime: e.eventTime, space: { name: space }, user: user, message: { name: space + '/messages/private-' + jbHash(e.message.name + '/' + user.name + '/' + e.eventTime + '/' + command + '/' + song), argumentText: verb + ' ' + song, sender: user } };
  var result = jbHandleMessage(request), accepted = /접수했습니다|이미 접수/.test(result.text || '');
  return jbDialogStatus(accepted ? 'OK' : 'INVALID_ARGUMENT', accepted ? '푸루! 비공개로 접수했어. 아직 재생 확인은 아니야. 잠시 후 내 신청 결과 · 비공개에서 확인해 줘!' : String(result.text || '신청을 확인하지 못했어.'));
}
