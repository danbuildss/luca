import { describe, it, expect } from 'vitest';
import { isQuietHours, localHour, localTime, validTimezone, ANY_HOUR_ALERTS } from '../../src/notify/quiet-hours.js';
import { placeName } from '../../src/notify/timezone.js';

describe('quiet hours (22:00 to 08:00 on the operator\'s clock)', () => {
  it('Oct 4, 00:00 UTC is 01:00 in London: quiet', () => {
    const t = new Date('2026-10-04T00:00:00Z');
    expect(localHour('Europe/London', t)).toBe(1);
    expect(isQuietHours('Europe/London', t)).toBe(true);
  });

  it('the edges: 21:59 and 08:00 are not quiet, 22:00 and 07:59 are', () => {
    expect(isQuietHours('UTC', new Date('2026-10-04T21:59:00Z'))).toBe(false);
    expect(isQuietHours('UTC', new Date('2026-10-04T22:00:00Z'))).toBe(true);
    expect(isQuietHours('UTC', new Date('2026-10-04T07:59:00Z'))).toBe(true);
    expect(isQuietHours('UTC', new Date('2026-10-04T08:00:00Z'))).toBe(false);
  });

  it('the same moment differs by timezone', () => {
    const t = new Date('2026-10-04T21:30:00Z');
    expect(isQuietHours('UTC', t)).toBe(false);
    expect(isQuietHours('Africa/Lagos', t)).toBe(true); // 22:30
    expect(isQuietHours('America/New_York', t)).toBe(false); // 17:30
  });

  it('an unknown timezone falls back to UTC instead of throwing', () => {
    expect(validTimezone('Mars/Base')).toBe(false);
    expect(validTimezone('Europe/London')).toBe(true);
    expect(isQuietHours('Mars/Base', new Date('2026-10-04T23:00:00Z'))).toBe(true);
    expect(localTime('Mars/Base', new Date('2026-10-04T13:05:00Z'))).toBe('13:05');
  });

  it('only what answers the operator, and admin alerts about Luca, go out at any hour', () => {
    expect([...ANY_HOUR_ALERTS].sort()).toEqual(['disk_pressure', 'wallet_read_failed', 'wallet_ready', 'wallet_stale', 'worker_stale']);
    for (const t of ['large_inflow', 'large_outflow', 'books_attention', 'spend_spike', 'classifier_degradation']) expect(ANY_HOUR_ALERTS.has(t), t).toBe(false);
  });

  it('names a place from its timezone', () => {
    expect(placeName('Europe/London')).toBe('London');
    expect(placeName('America/New_York')).toBe('New York');
    expect(placeName('UTC')).toBe('UTC');
  });
});
