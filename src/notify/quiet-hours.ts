// Nothing Luca sends on its own reaches an operator between 22:00 and 08:00 in their
// timezone (users.timezone, UTC until they tell Luca theirs). Held messages go out after
// 08:00. A few go out at any hour: the answer to something the operator just did (their
// new wallet is ready, or could not be read), and admin alerts about Luca itself.

export const QUIET_FROM_HOUR = 22;
export const QUIET_UNTIL_HOUR = 8;

export const ANY_HOUR_ALERTS: ReadonlySet<string> = new Set([
  'wallet_ready', 'wallet_read_failed', 'worker_stale', 'wallet_stale', 'disk_pressure',
]);

export function validTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// The hour (0-23) on the operator's clock; UTC for a timezone that is not valid
export function localHour(timezone: string, now: Date = new Date()): number {
  const zone = validTimezone(timezone) ? timezone : 'UTC';
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }).format(now);
  return parseInt(h, 10) % 24;
}

export function isQuietHours(timezone: string, now: Date = new Date()): boolean {
  const h = localHour(timezone, now);
  return h >= QUIET_FROM_HOUR || h < QUIET_UNTIL_HOUR;
}

// "14:05" on the operator's clock
export function localTime(timezone: string, now: Date = new Date()): string {
  const zone = validTimezone(timezone) ? timezone : 'UTC';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(now);
}
