import { query } from '../db.js';
import { localTime, validTimezone, QUIET_FROM_HOUR, QUIET_UNTIL_HOUR } from './quiet-hours.js';

// The operator's timezone, from what they tell Luca in chat ("I'm in London"). A
// preference, not the books: saved straight away, in Luca's own words.

// "Europe/London" -> "London", "America/New_York" -> "New York"
export function placeName(timezone: string): string {
  return (timezone.split('/').pop() ?? timezone).replace(/_/g, ' ');
}

const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;

export async function setTimezone(userId: string, timezone: string, now: Date = new Date()): Promise<string> {
  // Only a name the clock knows; "Mars/Base" is refused and nothing is saved
  if (!validTimezone(timezone) || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) {
    return "I don't recognise that timezone, so I haven't changed anything. Which city are you in, for example London or Lagos?";
  }
  // The canonical spelling ("europe/london" -> "Europe/London")
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  await query(`UPDATE users SET timezone = $2 WHERE id = $1`, [userId, zone]);
  return `Got it, I'll use ${placeName(zone)} time (it's ${localTime(zone, now)} there now). I won't message you between ${hh(QUIET_FROM_HOUR)} and ${hh(QUIET_UNTIL_HOUR)}.`;
}
