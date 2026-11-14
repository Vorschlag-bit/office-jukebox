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
    var text = m.argumentText;
    if (typeof text !== 'string') {
      text = m.text || '';
      (m.annotations || []).filter(function(a) { return a.type === 'USER_MENTION' && a.userMention && a.userMention.user.type === 'BOT'; }).sort(function(a,b) { return b.startIndex-a.startIndex; }).forEach(function(a) { var s = a.startIndex || 0; text = text.slice(0,s) + text.slice(s+a.length); });
    }
    text = text.trim();
    if (text === '내정보') return { text: '스페이스: ' + space + '\n사용자: ' + u.name + '\n리소스 ID는 비밀 키가 아닙니다. 공개 저장소에는 올리지 마세요.' };
    if (!text || text.length > 500 || !m.name || m.name.length > 250) return { text: '명령은 1~500자이며 메시지 ID가 필요합니다.' };
    return jbLocked(function(p) {
      if (jbSpaces(p).indexOf(space) < 0) return { text: '허용되지 않은 스페이스입니다. 내정보로 ID를 확인하고 ALLOWED_SPACES를 설정하세요.' };
      if (text === '결과') {
        var r = jbRead(p, 'r_' + jbHash(space + '/' + u.name), null);
        return { text: r && Date.now() - r.at < 86400000 ? jbSafe(r.text) + '\n[노트북 처리 결과: ' + new Date(r.at).toISOString() + ']' : '아직 처리 결과가 없습니다. 노트북 서버 실행·연결 상태를 확인하세요.' };
      }
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
      return { text: '접수했습니다. 보통 5~10초 후 @앱 결과 로 확인하세요. 접수는 실제 재생 확인과 다릅니다.' };
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
