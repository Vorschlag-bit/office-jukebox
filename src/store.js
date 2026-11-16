import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from './persistence.js';

export function emptyState() {
  return { version: 1, queue: [], current: null, history: [], seen: {}, outbox: [], deadLetters: [], candidates: {}, paused: false };
}
export function validateState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.queue) || !Array.isArray(state.outbox) || !Array.isArray(state.history) || !state.seen || typeof state.seen !== 'object' || Array.isArray(state.seen)) throw new Error('지원하지 않거나 손상된 state.json');
  if ((state.deadLetters !== undefined && !Array.isArray(state.deadLetters)) || (state.paused !== undefined && typeof state.paused !== 'boolean') || (state.candidates !== undefined && (!state.candidates || typeof state.candidates !== 'object' || Array.isArray(state.candidates)))) throw new Error('저장소의 운영 상태가 손상됐습니다.');
  if ((state.backgroundSuppressed !== undefined && typeof state.backgroundSuppressed !== 'boolean') || (state.backgroundIndex !== undefined && (!Number.isInteger(state.backgroundIndex) || state.backgroundIndex < 0 || state.backgroundIndex >= 1000000))) throw new Error('배경음악 상태가 손상됐습니다.');
  for (const reply of [...state.outbox, ...(state.deadLetters || [])]) if (!reply || typeof reply.id !== 'string' || typeof reply.text !== 'string' || !/^spaces\/[A-Za-z0-9_-]+$/.test(reply.space || '')) throw new Error('알림 저장소 데이터가 손상됐습니다.');
  for (const song of [...state.queue, ...(state.current ? [state.current] : [])]) {
    if (!song || typeof song.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(song.videoId || '') || typeof song.title !== 'string' || !Number.isFinite(song.expiresAt)) throw new Error('대기열 데이터가 손상됐습니다.');
  }
  return state;
}
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'state.json');
    // Never silently overwrite a damaged queue.
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : emptyState();
    validateState(this.state);
    this.state.deadLetters ||= []; this.state.candidates ||= {}; this.state.paused ||= false;
  }
  save() {
    atomicJson(this.file, this.state, { backup: true });
  }
}
export class MemoryStore {
  constructor() { this.state = emptyState(); }
  save() {}
}
