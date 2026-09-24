import { describe, it, expect } from 'vitest';
import { UserRateLimiter, singleFlight } from '../../src/telegram/ratelimit.js';

function makeLimiter(maxPerWindow = 3, windowMs = 1000) {
  let t = 0;
  const limiter = new UserRateLimiter({ maxPerWindow, windowMs, now: () => t });
  return { limiter, advance: (ms: number) => { t += ms; } };
}

describe('UserRateLimiter', () => {
  it('allows one concurrent run per user', () => {
    const { limiter } = makeLimiter();
    expect(limiter.tryAcquire('u1')).toEqual({ ok: true });
    expect(limiter.tryAcquire('u1')).toEqual({ ok: false, reason: 'busy' });
    // other users are unaffected
    expect(limiter.tryAcquire('u2')).toEqual({ ok: true });
    limiter.release('u1');
    expect(limiter.tryAcquire('u1')).toEqual({ ok: true });
  });

  it('rate limits after maxPerWindow messages and recovers after the window', () => {
    const { limiter, advance } = makeLimiter(3, 1000);
    for (let i = 0; i < 3; i++) {
      expect(limiter.tryAcquire('u1').ok).toBe(true);
      limiter.release('u1');
      advance(100);
    }
    const blocked = limiter.tryAcquire('u1');
    expect(blocked).toEqual({ ok: false, reason: 'rate_limited', retryAfterMs: 700 });

    advance(700); // first hit (t=0) leaves the window
    expect(limiter.tryAcquire('u1').ok).toBe(true);
  });

  it('does not count rejected attempts toward the window', () => {
    const { limiter } = makeLimiter(2, 1000);
    expect(limiter.tryAcquire('u1').ok).toBe(true);
    expect(limiter.tryAcquire('u1').ok).toBe(false); // busy — not counted
    limiter.release('u1');
    expect(limiter.tryAcquire('u1').ok).toBe(true);
  });
});

describe('singleFlight', () => {
  it('coalesces overlapping calls into one run', async () => {
    let runs = 0;
    let resolve!: () => void;
    const job = singleFlight(() => {
      runs++;
      return new Promise<void>((r) => { resolve = r; });
    });

    const a = job();
    const b = job();
    expect(runs).toBe(1);
    resolve();
    await Promise.all([a, b]);

    const c = job();
    expect(runs).toBe(2);
    resolve();
    await c;
  });

  it('allows a new run after a failure', async () => {
    let runs = 0;
    // eslint-disable-next-line @typescript-eslint/require-await -- the throw must surface as a rejection
    const job = singleFlight(async () => {
      runs++;
      if (runs === 1) throw new Error('boom');
    });
    await expect(job()).rejects.toThrow('boom');
    await job();
    expect(runs).toBe(2);
  });
});
