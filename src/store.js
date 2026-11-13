import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function emptyState() {
  return { version: 1, queue: [], current: null, history: [], seen: {}, outbox: [] };
}
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'state.json');
    // Never silently overwrite a damaged queue.
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : emptyState();
    if (this.state.version !== 1 || !Array.isArray(this.state.queue) || !Array.isArray(this.state.outbox)) throw new Error('지원하지 않거나 손상된 state.json');
  }
  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
export class MemoryStore {
  constructor() { this.state = emptyState(); }
  save() {}
}
