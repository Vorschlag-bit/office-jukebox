import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';
import { BrowserAdapter } from '../src/adapters.js';

test('seeded 1500-step soak: queue invariants survive concurrent requests, pauses, errors and restarts', async () => {
  let clock = 100000, seed = 912381;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const store = new MemoryStore();
  const options = { store, adapter: new BrowserAdapter(), now: () => clock, maxQueue: 20, queueTtlMs: 5000, autoSkipUnplayable: true, youtube: { resolve: async title => ({ videoId: 'dQw4w9WgXcQ', title }) } };
  let engine = new Engine(options); await engine.heartbeat('client-soak');
  for (let i = 0; i < 1500; i++) {
    const action = random() % 10;
    if (action < 3 && engine.state.queue.length < 18) {
      await Promise.all([engine.command({ text: `추가 song-${i}`, eventId: `event-${i}` }), engine.command({ text: `추가 song-${i}`, eventId: `event-${i}` })]);
    } else if (action === 3 && engine.state.current && !['error', 'recovery_required'].includes(engine.state.current.status)) {
      const sessionId = engine.state.current.sessionId;
      await engine.playerEvent({ clientId: 'client-soak', sessionId, event: 'playing' });
      await engine.playerEvent({ clientId: 'client-soak', sessionId, event: 'ended' });
      await assert.rejects(engine.playerEvent({ clientId: 'client-soak', sessionId, event: 'ended' }), { code: 'STALE' });
    } else if (action === 4) await engine.command({ text: '일시정지', operator: true });
    else if (action === 5) await engine.command({ text: '계속', operator: true });
    else if (action === 6) await engine.command({ text: '다음', operator: true });
    else if (action === 7 && engine.state.queue.length) await engine.command({ text: `취소 id:${engine.state.queue[0].id}`, operator: true });
    else if (action === 8) {
      engine = new Engine(options);
      if (engine.state.current) assert.equal(engine.state.current.status, 'recovery_required');
      await engine.heartbeat('client-soak');
      if (engine.state.current) await engine.command({ text: '재시도', operator: true });
    } else { clock += 100; await engine.tick(); await engine.heartbeat('client-soak'); }
    const ids = [...engine.state.queue.map(x => x.id), ...(engine.state.current ? [engine.state.current.id] : [])];
    assert.equal(new Set(ids).size, ids.length); assert.ok(engine.state.queue.length <= 20);
    const archived = new Set(engine.state.history.map(x => x.id)); assert.ok(ids.every(id => !archived.has(id)));
    assert.equal(new Set(engine.state.history.map(x => x.id)).size, engine.state.history.length);
  }
});
