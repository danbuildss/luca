// In-memory per-user limiter for free-text agent runs. Each message can trigger
// several LLM calls, so we cap both concurrency (one run at a time per user) and
// volume (sliding window). Process-local by design.

export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number };

export type RateLimiterOptions = {
  maxPerWindow: number;
  windowMs: number;
  now?: () => number;
};

export class UserRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly running = new Set<string>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.maxPerWindow = opts.maxPerWindow;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
  }

  // On success the caller MUST call release(userId) when the run finishes.
  tryAcquire(userId: string): AcquireResult {
    if (this.running.has(userId)) return { ok: false, reason: 'busy' };

    const t = this.now();
    const recent = (this.hits.get(userId) ?? []).filter((ts) => t - ts < this.windowMs);
    if (recent.length >= this.maxPerWindow) {
      this.hits.set(userId, recent);
      return { ok: false, reason: 'rate_limited', retryAfterMs: this.windowMs - (t - recent[0]) };
    }

    recent.push(t);
    this.hits.set(userId, recent);
    this.running.add(userId);
    return { ok: true };
  }

  release(userId: string): void {
    this.running.delete(userId);
    const t = this.now();
    const recent = (this.hits.get(userId) ?? []).filter((ts) => t - ts < this.windowMs);
    if (recent.length === 0) this.hits.delete(userId);
    else this.hits.set(userId, recent);
  }
}

// Coalesce overlapping calls to an async job: while one run is in flight,
// further calls return the same promise instead of starting a second run.
export function singleFlight(fn: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = fn().finally(() => { inFlight = null; });
    return inFlight;
  };
}
