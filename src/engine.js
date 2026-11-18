import { randomUUID } from 'node:crypto';
import { check } from './util.js';
import { playlistId } from './youtube.js';
import { backgroundTrack } from './background.js';

export class Engine {
  constructor({ store, youtube, adapter, now = Date.now, maxQueue = 50, queueTtlMs = 14400000, perUserLimit = 0, autoSkipUnplayable = false, handshakeTimeoutMs = 45000, background = { enabled: false } }) {
    Object.assign(this, { store, youtube, adapter, now, maxQueue, queueTtlMs, perUserLimit, autoSkipUnplayable, handshakeTimeoutMs, background });
    this.chain = Promise.resolve();
    this.player = null;
    this.consecutiveFailures = 0;
    this.adapter.setListener?.(event => { void this.nativeEvent(event).catch(() => {}); });
    if (this.state.current) { this.state.current.status = 'recovery_required'; store.save(); }
  }
  get state() { return this.store.state; }
  async start() {
    return this.serial(async () => {
      if (this.state.current && typeof this.adapter.attach === 'function') await this.adapter.attach(this.state.current);
      else if (!this.state.current) await this.dispatch();
    });
  }
  serial(work) {
    const result = this.chain.then(work);
    this.chain = result.catch(() => {});
    return result;
  }
  snapshot() {
    const publicTrack = track => track ? Object.fromEntries(['id', 'videoId', 'title', 'source', 'status', 'sessionId', 'desiredState', 'controlVersion', 'error', 'confirmation'].filter(key => Object.hasOwn(track, key)).map(key => [key, track[key]])) : null;
    return structuredClone({ queue: this.state.queue.map(publicTrack), current: publicTrack(this.state.current), history: this.state.history.slice(-10).map(publicTrack), paused: !!this.state.paused, adapter: this.adapter.info(), notifications: { pending: this.state.outbox.length, failed: this.state.deadLetters?.length || 0 }, player: this.player ? { online: this.now() - this.player.lastSeen < 15000 } : { online: false } });
  }
  notify(text, track = this.state.current) {
    if (track?.requestSpace && this.state.outbox.length < 500) this.state.outbox.push({ id: randomUUID(), space: track.requestSpace, user: track.requestedBy, thread: track.requestThread, text });
  }
  archive(status, error) {
    if (!this.state.current) return;
    this.state.history.push({ ...this.state.current, status, error, finishedAt: this.now() });
    this.state.history = this.state.history.slice(-100);
    this.state.current = null;
  }
  expire() {
    const stale = this.state.queue.filter(x => x.expiresAt <= this.now());
    if (!stale.length) return false;
    this.state.queue = this.state.queue.filter(x => x.expiresAt > this.now());
    this.state.history.push(...stale.map(x => ({ ...x, status: 'expired', finishedAt: this.now() })));
    this.state.history = this.state.history.slice(-100);
    return true;
  }
  async dispatch() {
    const expired = this.expire();
    if (this.adapter.type === 'browser' && (!this.player || this.now() - this.player.lastSeen >= 15000)) { if (expired) this.store.save(); return; }
    const current = this.state.current;
    // Request-first policy: only actually observed, playing BGM/manual TV music
    // yields to queued requests. Recovery, error and pause never get overwritten.
    if (['background', 'external_tv'].includes(current?.source) && current.observedPlaying && ['playing', 'buffering'].includes(current.status) && current.desiredState !== 'paused' && !this.state.paused && this.state.queue.length) {
      if (current.source === 'external_tv') this.state.manualReturn = { id: current.id, videoId: current.videoId, title: current.title, source: 'external_tv', addedAt: this.now(), expiresAt: this.now() + 7 * 86400000, resumePositionSeconds: Number.isFinite(current.positionSeconds) && Number.isFinite(current.durationSeconds) && current.durationSeconds > current.positionSeconds ? current.positionSeconds : 0 };
      this.archive(current.source === 'background' ? 'background_yielded' : 'tv_yielded');
    }
    if (this.state.current || this.state.paused) { if (expired) this.store.save(); return; }
    let track = this.state.queue.shift();
    if (!track && this.state.manualReturn && !this.state.backgroundSuppressed && this.adapter.type === 'lounge') {
      const previous = this.state.manualReturn; this.state.manualReturn = null;
      if (previous.expiresAt > this.now()) track = { ...previous, id: randomUUID(), addedAt: this.now(), expiresAt: this.now() + 7 * 86400000 };
      else this.store.save();
    }
    if (!track && this.background.enabled && !this.state.backgroundSuppressed && ['browser', 'lounge'].includes(this.adapter.type)) {
      track = { ...backgroundTrack(this.now(), this.state.backgroundIndex || 0), id: randomUUID(), addedAt: this.now(), expiresAt: this.now() + 7 * 86400000 };
      this.state.backgroundIndex = ((this.state.backgroundIndex || 0) + 1) % 1000000;
    }
    if (!track) { if (expired) this.store.save(); return; }
    this.state.current = { ...track, sessionId: randomUUID(), status: 'dispatching', dispatchedAt: this.now(), desiredState: 'playing', controlVersion: 0, observedPlaying: false };
    // Persist before the external side effect: restart requires explicit recovery, never blindly replays.
    this.store.save();
    try {
      const result = await this.adapter.play(this.state.current);
      this.state.current.status = result.confirmed ? 'playing' : 'sent_unconfirmed';
    } catch (e) {
      // Keep the item for explicit retry; a transport timeout may mean the TV did receive it.
      this.state.current.status = 'error';
      this.state.current.error = e.code || 'DEVICE_ERROR';
      this.notify(`재생 요청 실패: ${track.title} [${this.state.current.error}]. 상태를 확인하고 재시도 또는 다음을 선택하세요.`);
    }
    this.store.save();
  }
  async command({ text, user = 'local', operator = false, eventId, space, thread, selectionId, includeChoices = false }) {
    return this.serial(async () => {
      if (eventId && Object.hasOwn(this.state.seen, eventId)) return includeChoices ? structuredClone(this.state.seen[eventId].publicResult || {text:this.state.seen[eventId].reply}) : this.state.seen[eventId].reply;
      check(typeof text === 'string' && text.length <= 500, 'COMMAND', '명령은 500자 이내여야 합니다.');
      const [verb = '', ...parts] = text.trim().split(/\s+/);
      const arg = parts.join(' ');
      let reply;
      const append = async song => {
        check(this.state.queue.length < this.maxQueue, 'QUEUE_FULL', '대기열이 가득 찼습니다.');
        check(this.state.outbox.length < 500, 'NOTIFICATIONS_FULL', 'Chat 응답이 누적됐습니다. 운영자가 알림 상태를 확인해야 합니다.', 503);
        check(!this.perUserLimit || this.state.queue.filter(x => x.requestedBy === user).length < this.perUserLimit, 'USER_LIMIT', `한 사람은 대기곡을 ${this.perUserLimit}개까지 신청할 수 있습니다.`);
        this.state.queue.push({ ...song, id: randomUUID(), requestedBy: user, addedAt: this.now(), expiresAt: this.now() + this.queueTtlMs, requestSpace: space, requestThread: thread });
        this.state.backgroundSuppressed = false;
        reply = `대기열에 담았어요: ${song.title}. ${['background','external_tv'].includes(this.state.current?.source) ? '배경음악보다 우선해서 재생돼요.' : '현재 곡이 끝나면 순서대로 재생돼요.'}`;
      };
      const listCommand = ['목록', '재생목록', 'playlist'].includes(verb.toLowerCase());
      const plainPlaylist = ['재생', '추가', 'play', 'add'].includes(verb.toLowerCase()) && playlistId(arg) && new URL(arg).pathname === '/playlist';
      if (listCommand || plainPlaylist) {
        const [url, startText = '1', ...extra] = parts;
        check(!extra.length && /^[1-9][0-9]{0,2}$/.test(startText), 'PLAYLIST_START', '목록 <링크> [시작번호] 형식으로 입력하세요. 시작번호는 1~100입니다.');
        const start = Number(startText);
        check(start <= 100, 'PLAYLIST_START', '처음 공개된 최대 100곡까지 읽을 수 있어요. 시작번호는 1~100입니다.');
        check(this.state.queue.length < this.maxQueue, 'QUEUE_FULL', '대기열이 가득 찼습니다.');
        const remaining = this.perUserLimit ? this.perUserLimit - this.state.queue.filter(x => x.requestedBy === user).length : 20;
        check(remaining > 0, 'USER_LIMIT', `한 사람은 대기곡을 ${this.perUserLimit}개까지 신청할 수 있습니다.`);
        check(this.state.outbox.length < 500, 'NOTIFICATIONS_FULL', 'Chat 응답이 누적됐습니다. 운영자가 알림 상태를 확인해야 합니다.', 503);
        const songs = await this.youtube.playlist(url);
        check(start <= songs.length, 'PLAYLIST_START', `읽어 온 목록은 ${songs.length}곡이에요. 시작번호를 줄여 주세요.`);
        const batch = songs.slice(start - 1, start - 1 + Math.min(20, remaining, this.maxQueue - this.state.queue.length));
        for (const song of batch) await append(song);
        const next = start + batch.length;
        reply = `재생목록 ${batch.length}곡을 대기열에 담았어요 (${start}~${next - 1}번). 기존 신청곡 뒤에 순서대로 재생돼요.\n` + batch.slice(0, 5).map((song, i) => `${start + i}. ${song.title.slice(0, 100)}`).join('\n') + (batch.length > 5 ? `\n외 ${batch.length - 5}곡` : '') + `\n공개 목록의 처음 최대 100곡을 읽으며 중복·비공개 곡은 제외해요. 한 번에 최대 20곡, 개인·전체 대기열 제한을 적용합니다.`;
        if (next <= songs.length) reply += `\n곡이 재생되어 신청 자리가 생기면 이어담기: 목록 ${url} ${next}`;
      } else if (['재생', '추가', 'play', 'add'].includes(verb.toLowerCase())) {
        check(this.state.queue.length < this.maxQueue, 'QUEUE_FULL', '대기열이 가득 찼습니다.');
        check(!this.perUserLimit || this.state.queue.filter(x => x.requestedBy === user).length < this.perUserLimit, 'USER_LIMIT', `한 사람은 대기곡을 ${this.perUserLimit}개까지 신청할 수 있습니다.`);
        await append(await this.youtube.resolve(arg, this.adapter.type === 'browser'));
      } else if (['검색', 'search'].includes(verb.toLowerCase())) {
        const songs = await this.youtube.search(arg, this.adapter.type === 'browser');
        this.state.candidates ||= {};
        for (const key of Object.keys(this.state.candidates)) if (this.state.candidates[key].expiresAt <= this.now()) delete this.state.candidates[key];
        check(Object.keys(this.state.candidates).length < 100 || this.state.candidates[user], 'CANDIDATES_FULL', '검색 사용자가 많습니다. 잠시 후 다시 시도하세요.');
        this.state.candidates[user] = { songs, space, expiresAt: this.now() + 300000, selectionId: randomUUID() };
        reply = songs.map((x, i) => `${i + 1}. ${x.title}`).join('\n') + '\n5분 이내에 선택 <번호>를 보내세요.';
      } else if (['선택', 'select'].includes(verb.toLowerCase())) {
        const choice = this.state.candidates?.[user];
        check(choice && choice.expiresAt > this.now() && choice.space === space, 'CHOICE_EXPIRED', '검색 결과가 만료됐거나 다른 채팅방의 결과입니다. 다시 검색하세요.');
        if(selectionId !== undefined) check(selectionId === choice.selectionId, 'CHOICE_EXPIRED', '새 검색 결과가 있어요. 화면에서 다시 검색한 뒤 골라 주세요.', 409);
        check(/^[1-5]$/.test(arg) && choice.songs[Number(arg) - 1], 'CHOICE', '검색 결과의 번호를 선택하세요.');
        await append(choice.songs[Number(arg) - 1]); delete this.state.candidates[user];
      } else if (['취소', 'cancel'].includes(verb.toLowerCase())) {
        check(/^[1-9][0-9]*$/.test(arg) || /^id:[a-f0-9-]{36}$/.test(arg), 'CANCEL', '대기열에 표시된 곡 번호를 입력하세요.');
        const index = arg.startsWith('id:') ? this.state.queue.findIndex(x => x.id === arg.slice(3)) : Number(arg) - 1, song = this.state.queue[index];
        check(song, 'CANCEL', '해당 대기곡이 없습니다.');
        check(operator || song.requestedBy === user, 'FORBIDDEN', '본인의 신청곡만 취소할 수 있습니다.', 403);
        this.state.queue.splice(index, 1); reply = `신청 취소: ${song.title}`;
      } else if (['일시정지', 'pause', '계속', 'resume'].includes(verb.toLowerCase())) {
        check(operator, 'FORBIDDEN', '운영자만 실행할 수 있는 명령입니다.', 403);
        const pause = ['일시정지', 'pause'].includes(verb.toLowerCase());
        if (this.state.current) {
          check(!['error', 'recovery_required'].includes(this.state.current.status), 'RECOVERY', '오류 또는 복구 상태에서는 재시도 또는 다음을 사용하세요.');
          if (this.adapter.type !== 'browser') {
            check(typeof this.adapter[pause ? 'pause' : 'resume'] === 'function', 'UNSUPPORTED', '이 어댑터는 일시정지/계속을 지원하지 않습니다.');
            await this.adapter[pause ? 'pause' : 'resume']();
          }
          this.state.current.desiredState = pause ? 'paused' : 'playing';
          this.state.current.controlVersion = (this.state.current.controlVersion || 0) + 1;
        }
        this.state.paused = pause;
        if (!pause) this.state.backgroundSuppressed = false;
        if (!pause) this.consecutiveFailures = 0;
        reply = pause ? '일시정지를 요청했습니다. 다음 곡 자동 시작도 보류합니다.' : '재생 계속을 요청했습니다.';
      } else if (['대기열', 'queue', '상태', 'status'].includes(verb.toLowerCase())) {
        const current = this.state.current;
        reply = `현재: ${current ? `${current.title} [${current.status}]` : '없음'}${this.state.paused ? ' · 대기열 일시정지' : ''}\n대기: ${this.state.queue.map((x, i) => `${i + 1}. ${x.title}`).join('\n') || '없음'}`;
      } else if (['다음', 'next', '정지', 'stop', '재시도', 'retry', '확인', 'confirm'].includes(verb.toLowerCase())) {
        check(operator, 'FORBIDDEN', '운영자만 실행할 수 있는 명령입니다.', 403);
        if (['확인', 'confirm'].includes(verb.toLowerCase())) {
          check(this.state.current && this.adapter.type !== 'browser', 'NO_CURRENT', '확인할 기본 앱 재생 요청이 없습니다.');
          check(['sent_unconfirmed', 'recovery_required', 'error'].includes(this.state.current.status), 'STATE', '현재 상태에서는 확인할 수 없습니다.');
          this.state.current.status = 'playing';
          this.state.current.confirmation = 'operator';
          reply = '현장에서 재생을 확인한 것으로 기록했습니다. 곡 종료 후 다음 명령을 사용하세요.';
        } else if (['재시도', 'retry'].includes(verb.toLowerCase())) {
          check(this.state.current, 'NO_CURRENT', '재시도할 곡이 없습니다.');
          check(['error', 'recovery_required'].includes(this.state.current.status), 'STATE', '오류 또는 재시작 복구 상태에서만 재시도할 수 있습니다.');
          await this.adapter.stop();
          const { sessionId, status, error, dispatchedAt, confirmation, observedPlaying, notifiedPlaying, ...song } = this.state.current;
          this.state.queue.unshift({ ...song, expiresAt: this.now() + this.queueTtlMs });
          this.state.current = null;
          this.consecutiveFailures = 0;
          reply = '재시도를 접수했습니다.';
        } else {
          await this.adapter.stop(); // On failure preserve state rather than falsely reporting stopped.
          const stop = ['정지', 'stop'].includes(verb.toLowerCase());
          this.archive(stop ? 'stopped' : 'skipped');
          if (stop) { this.state.queue = []; this.state.manualReturn = null; }
          if (stop) this.state.paused = false;
          if (stop) this.state.backgroundSuppressed = true;
          this.consecutiveFailures = 0;
          reply = stop ? (this.adapter.type === 'browser' ? '재생을 멈추고 대기열을 비웠어요.' : '정지 명령 전송 및 대기열 비움 완료. 기본 앱은 현장 정지를 확인하세요.') : '다음 곡으로 이동합니다.';
        }
      } else reply = '명령: 추가 <곡명/URL> · 목록 <재생목록 링크> [시작번호] · 검색 <곡명> · 선택 <번호> · 취소 <대기번호> · 대기열 · 상태 · 다음 · 정지 · 일시정지 · 계속 · 재시도 · 확인. 추가는 검색 첫 결과를 신청합니다.';
      const publicResult = includeChoices ? { text: reply, ...(['검색','search'].includes(verb.toLowerCase()) ? { choices: this.state.candidates[user].songs.map(x=>({videoId:x.videoId,title:x.title})), selectionId: this.state.candidates[user].selectionId, expiresAt: this.state.candidates[user].expiresAt } : {}) } : undefined;
      if (eventId) {
        Object.defineProperty(this.state.seen, eventId, { value: { reply: reply.slice(0, 4000), at: this.now(), ...(publicResult ? {publicResult} : {}) }, writable: true, enumerable: true, configurable: true });
        // Bound deduplication storage; delivery TTL and Pub/Sub retention are separate concerns.
        const keys = Object.keys(this.state.seen);
        for (const key of keys.slice(0, Math.max(0, keys.length - 5000))) delete this.state.seen[key];
        if (space) this.state.outbox.push({ id: randomUUID(), space, user, thread, text: reply });
      }
      this.store.save();
      await this.dispatch();
      return publicResult || reply;
    });
  }
  async heartbeat(clientId) {
    return this.serial(async () => {
      check(this.adapter.type === 'browser', 'ADAPTER', '브라우저 재생 모드가 아닙니다.');
      check(typeof clientId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(clientId), 'CLIENT', '올바르지 않은 재생기 ID');
      check(!this.player || this.player.id === clientId || this.now() - this.player.lastSeen >= 15000, 'LEASE', '다른 브라우저가 재생 중입니다.', 409);
      // A replacement tab must not replay an existing item without operator recovery.
      if (this.player && (this.player.id !== clientId || this.now() - this.player.lastSeen >= 15000) && this.state.current) { this.state.current.status = 'recovery_required'; this.store.save(); }
      this.player = { id: clientId, lastSeen: this.now() };
      await this.dispatch();
      return this.snapshot();
    });
  }
  async applyPlayback(event, errorCode) {
    const current = this.state.current;
    if (current.status === event && event !== 'error') return;
    if (event === 'ended') {
      check(current.observedPlaying, 'ENDING_BEFORE_PLAY', '재생 확인 전 종료 이벤트는 무시합니다.', 409);
      this.consecutiveFailures = 0; this.archive('ended'); await this.dispatch();
    } else if (event === 'error' && this.autoSkipUnplayable && [100, 101, 150].includes(Number(errorCode))) {
      this.consecutiveFailures++;
      this.notify(`이 영상은 재생할 수 없습니다: ${current.title}. ${this.consecutiveFailures >= 3 ? '연속 오류로 대기열을 일시정지합니다.' : '다음 곡을 시도합니다.'}`);
      this.archive('unplayable', `YOUTUBE_${Number(errorCode)}`);
      if (this.consecutiveFailures >= 3) this.state.paused = true;
      await this.dispatch();
    } else {
      current.status = event;
      if (event === 'playing') {
        this.consecutiveFailures = 0;
        current.observedPlaying = true;
        if (!current.notifiedPlaying) { this.notify(`재생 중: ${current.title}`); current.notifiedPlaying = true; }
        if (['background','external_tv'].includes(current.source) && this.state.queue.length) await this.dispatch();
      }
      if (event === 'error') { current.error = errorCode ? `YOUTUBE_${Number(errorCode)}` : 'PLAYER_ERROR'; this.notify(`재생 오류: ${current.title} [${current.error}]`); }
    }
    this.store.save();
  }
  async playerEvent({ clientId, sessionId, event, errorCode }) {
    return this.serial(async () => {
      check(this.player?.id === clientId && this.now() - this.player.lastSeen < 15000, 'LEASE', '재생기 연결이 만료되었습니다.', 409);
      check(this.state.current?.sessionId === sessionId, 'STALE', '이전 곡의 이벤트입니다.', 409);
      check(['playing', 'paused', 'ended', 'blocked', 'error'].includes(event), 'EVENT', '지원하지 않는 이벤트');
      check(errorCode === undefined || (Number.isInteger(errorCode) && errorCode >= 0 && errorCode <= 999), 'EVENT', '올바른 숫자 영상 오류 코드가 필요합니다.');
      check(this.state.current.status !== 'recovery_required', 'RECOVERY', '운영자의 재시도 또는 다음 명령이 필요합니다.', 409);
      await this.applyPlayback(event, errorCode);
      return this.snapshot();
    });
  }
  async nativeEvent({ sessionId, videoId, event, verifiedObservation = false, observedVideoId, observationSessionId, observedState, positionSeconds, durationSeconds }) {
    return this.serial(async () => {
      if (!this.state.current || this.state.current.sessionId !== sessionId || this.state.current.videoId !== videoId) return false;
      if (event === 'position' && this.adapter.type === 'lounge' && verifiedObservation) {
        const current = this.state.current;
        if (current.source !== 'external_tv') return false;
        let changed = false;
        for (const [key,value] of Object.entries({positionSeconds,durationSeconds})) if (Number.isFinite(value) && value >= 0 && value <= 604800 && current[key] !== value) { current[key] = value; changed = true; }
        if (changed) this.store.save(); return changed;
      }
      if (event === 'external' && this.adapter.type === 'lounge' && verifiedObservation && /^[A-Za-z0-9_-]{11}$/.test(observedVideoId || '') && /^[a-f0-9-]{36}$/.test(observationSessionId || '') && [1,2,3].includes(observedState)) {
        // A new TV selection replaces any earlier return intent. If requests
        // remain, dispatch will save this latest selection as their return target.
        this.state.manualReturn = null;
        this.notify('TV에서 수동으로 고른 영상을 따라갑니다. 기존 대기열은 유지됩니다.');
        this.archive('tv_replaced');
        const id = randomUUID();
        this.state.current = { id, videoId: observedVideoId, title: `YouTube ${observedVideoId}`, source: 'external_tv', sessionId: observationSessionId, status: observedState === 1 ? 'playing' : observedState === 2 ? 'paused' : 'buffering', desiredState: observedState === 2 ? 'paused' : 'playing', observedPlaying: observedState === 1, addedAt: this.now(), expiresAt: this.now() + 7 * 86400000, controlVersion: 0, ...(Number.isFinite(positionSeconds) && positionSeconds >= 0 && positionSeconds <= 604800 ? {positionSeconds} : {}), ...(Number.isFinite(durationSeconds) && durationSeconds >= 0 && durationSeconds <= 604800 ? {durationSeconds} : {}) };
        this.state.paused = observedState === 2;
        this.consecutiveFailures = 0; this.store.save();
        // Optional title lookup must not block events, controls or newer selections.
        if (typeof this.youtube.resolve === 'function') void Promise.resolve().then(() => this.youtube.resolve(`https://www.youtube.com/watch?v=${observedVideoId}`, false)).then(song => this.serial(async () => {
          if (song?.videoId !== observedVideoId || typeof song.title !== 'string' || !song.title.trim()) return;
          const track = this.state.current?.id === id ? this.state.current : this.state.manualReturn?.id === id ? this.state.manualReturn : null;
          if (track) { track.title = song.title.slice(0,300); this.store.save(); }
        })).catch(() => {});
        if (observedState === 1) await this.dispatch();
        return true;
      }
      if (this.state.current.status === 'error' && !(this.state.current.error === 'PLAYBACK_NOT_CONFIRMED' && this.adapter.type === 'lounge' && verifiedObservation && ['playing','paused'].includes(event))) return false;
      if (this.state.current.error === 'PLAYBACK_NOT_CONFIRMED' && verifiedObservation && ['playing','paused'].includes(event)) delete this.state.current.error;
      if (this.state.current.status === 'recovery_required' && !(this.adapter.type === 'lounge' && verifiedObservation && ['playing', 'paused', 'ended'].includes(event))) return false;
      if (event === 'idle' && this.adapter.type === 'lounge' && verifiedObservation && this.state.current.observedPlaying && !this.state.paused && this.state.current.desiredState !== 'paused') {
        // Receiver explicitly cleared its item twice. Preserve the distinction
        // from a nonce-bound natural end (it could also be a TV-side stop).
        this.archive('tv_idle'); this.consecutiveFailures = 0; this.store.save(); await this.dispatch(); return true;
      }
      if (event === 'offline' || event === 'external') { this.state.current.status = 'recovery_required'; this.notify(event === 'external' ? 'TV에서 다른 영상으로 변경됐습니다. 대기열을 진행하려면 재시도 또는 다음을 선택하세요.' : '기기 연결이 끊겼습니다. 실제 재생을 확인한 뒤 재시도 또는 다음을 선택하세요.'); this.store.save(); return true; }
      if (!['playing', 'paused', 'ended', 'buffering'].includes(event)) return false;
      if (this.state.current.source === 'external_tv' && verifiedObservation && ['playing','paused'].includes(event)) { this.state.paused = event === 'paused'; this.state.current.desiredState = event === 'paused' ? 'paused' : 'playing'; }
      await this.applyPlayback(event); return true;
    });
  }
  async tick() {
    return this.serial(async () => {
      const current = this.state.current;
      let changed = false;
      if (current && this.adapter.type === 'browser' && this.player && this.now() - this.player.lastSeen >= 15000 && !['recovery_required', 'error'].includes(current.status)) {
        current.status = 'recovery_required'; this.notify('재생기 연결이 만료됐습니다. 재연결 후 복구 명령이 필요합니다.');
        changed = true;
      } else if (current?.status === 'sent_unconfirmed' && this.now() - current.dispatchedAt >= this.handshakeTimeoutMs) {
        current.status = 'error'; current.error = 'PLAYBACK_NOT_CONFIRMED'; this.notify(`재생 확인 시간 초과: ${current.title}. 화면과 앱 연결을 확인하세요.`);
        changed = true;
      }
      if (this.expire()) changed = true;
      if (changed) this.store.save();
    });
  }
}
