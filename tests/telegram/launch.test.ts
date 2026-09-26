import { describe, it, expect, vi } from 'vitest';
import {
  launchWithRetry, isPollingConflict, CONFLICT_MESSAGE, FIRST_RETRY_MS, MAX_RETRY_MS,
  STABLE_AFTER_MS, type LaunchDeps,
} from '../../src/telegram/launch.js';

const conflict = () => Object.assign(new Error('409: Conflict: terminated by other getUpdates request'), {
  response: { ok: false, error_code: 409, description: 'Conflict' },
});

const conflicts = (n: number): Array<'conflict'> => Array.from({ length: n }, () => 'conflict' as const);

// A fake clock: sleeping advances time, and scheduled callbacks run when time passes them
function harness(outcomes: Array<'conflict' | 'ok' | Error | { runMs: number; then: 'conflict' }>) {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const advance = (ms: number) => {
    t += ms;
    for (const timer of timers) if (timer.live && timer.at <= t) { timer.live = false; timer.fn(); }
  };
  const sleeps: number[] = [];
  const notify = vi.fn(() => Promise.resolve());
  const info = vi.fn();
  const warn = vi.fn();
  let i = 0;
  const deps: LaunchDeps = {
    launch: () => {
      const o = outcomes[Math.min(i++, outcomes.length - 1)];
      if (o === 'ok') return Promise.resolve();
      if (o === 'conflict') { advance(5_000); return Promise.reject(conflict()); }
      if (o instanceof Error) return Promise.reject(o);
      advance(o.runMs);
      return Promise.reject(conflict());
    },
    notifyAdmins: notify,
    sleep: (ms) => { sleeps.push(ms); advance(ms); return Promise.resolve(); },
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
    now: () => t,
    log: { info, warn },
  };
  return { deps, sleeps, notify, info, warn, launches: () => i };
}

describe('isPollingConflict', () => {
  it('recognises Telegram 409 and nothing else', () => {
    expect(isPollingConflict(conflict())).toBe(true);
    expect(isPollingConflict(Object.assign(new Error('401'), { response: { error_code: 401 } }))).toBe(false);
    expect(isPollingConflict(new Error('network down'))).toBe(false);
    expect(isPollingConflict(null)).toBe(false);
  });
});

describe('launchWithRetry', () => {
  it('keeps running through a conflict and connects once the other copy is gone', async () => {
    const h = harness(['conflict', 'conflict', 'ok']);
    await expect(launchWithRetry(h.deps)).resolves.toBeUndefined();
    expect(h.launches()).toBe(3);
    expect(h.warn).toHaveBeenCalledWith(expect.anything(), 'Another copy of the Luca bot is using this token; retrying in 30s');
  });

  it('waits longer each time, capped at 5 minutes', async () => {
    const h = harness([...conflicts(8), 'ok']);
    await launchWithRetry(h.deps);
    expect(h.sleeps).toEqual([
      FIRST_RETRY_MS, 60_000, 120_000, 240_000, MAX_RETRY_MS, MAX_RETRY_MS, MAX_RETRY_MS, MAX_RETRY_MS,
    ]);
  });

  it('tells the admins once, only after the conflict has lasted 2 minutes', async () => {
    const h = harness([...conflicts(8), 'ok']);
    await launchWithRetry(h.deps);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(CONFLICT_MESSAGE);
    // Conflicts at 5s, 40s, 105s stay quiet; the one at 230s is past 2 minutes
    expect(h.sleeps.slice(0, 3)).toEqual([30_000, 60_000, 120_000]);
  });

  it('a short conflict that clears never messages the admins', async () => {
    const h = harness(['conflict', 'conflict', 'ok']);
    await launchWithRetry(h.deps);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('logs when the conflict is over and starts the next one from a 30s wait', async () => {
    // Two conflicts, then a minute of clean polling, then a new conflict
    const h = harness(['conflict', 'conflict', { runMs: STABLE_AFTER_MS + 1_000, then: 'conflict' }, 'ok']);
    await launchWithRetry(h.deps);
    expect(h.info).toHaveBeenCalledWith(expect.anything(), 'Bot connected; conflict with another copy resolved');
    expect(h.sleeps).toEqual([30_000, 60_000, 30_000]);
  });

  it('still stops on any other error, such as an invalid token', async () => {
    const bad = Object.assign(new Error('401: Unauthorized'), { response: { error_code: 401 } });
    const h = harness([bad]);
    await expect(launchWithRetry(h.deps)).rejects.toThrow('401: Unauthorized');
    expect(h.sleeps).toEqual([]);
  });

  it('does not retry while the process is shutting down', async () => {
    const h = harness(['conflict', 'ok']);
    h.deps.stopping = () => true;
    await expect(launchWithRetry(h.deps)).rejects.toThrow('409');
  });
});
