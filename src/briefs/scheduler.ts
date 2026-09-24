import cron from 'node-cron';
import { Telegram } from 'telegraf';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendMarkdownSafe } from '../telegram/format.js';
import {
  getAllBriefUsers, saveBrief, markBriefSent, updateBriefContent, getBriefSlotStatus,
  type BriefType, type BriefUser,
} from './store.js';
import { generateDailyBrief, generateWeeklyBrief } from './generate.js';

// Give up on a slot after this many failed attempts (e.g. user blocked the bot)
// so we don't regenerate + resend every minute all day. Resets on restart.
const MAX_ATTEMPTS_PER_SLOT = 5;

const DEFAULT_BRIEF_TIME = '08:00';

type LocalNow = {
  timezone: string; // validated IANA zone (falls back to UTC)
  date: string;     // YYYY-MM-DD
  time: string;     // HH:MM
  weekday: string;  // 'Mon', 'Tue', …
};

// Current date / time / weekday in the user's timezone
function localNow(timezone: string, now: Date): LocalNow {
  let tz = timezone;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = localParts(tz, now);
  } catch {
    tz = 'UTC';
    parts = localParts(tz, now);
  }
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour').replace(/^24$/, '00'); // midnight edge case
  return {
    timezone: tz,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
    weekday: get('weekday'),
  };
}

function localParts(timezone: string, now: Date): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short', timeZone: timezone,
  }).formatToParts(now);
}

function normalizeBriefTime(raw: string | null | undefined): string {
  return raw && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_BRIEF_TIME;
}

// Failed attempts per user+type for the current local date (in-process only)
const attempts = new Map<string, { date: string; count: number }>();

function attemptCount(key: string, date: string): number {
  const entry = attempts.get(key);
  return entry && entry.date === date ? entry.count : 0;
}

function recordFailure(key: string, date: string): void {
  attempts.set(key, { date, count: attemptCount(key, date) + 1 });
}

// Sends today's brief of `type` if its slot is open and it hasn't been sent yet.
// A saved-but-unsent row is reused on retry rather than inserting a new one.
async function deliverIfDue(params: {
  telegram: Telegram;
  user: BriefUser;
  local: LocalNow;
  briefTime: string;
  type: BriefType;
  now: Date;
}): Promise<void> {
  const { telegram, user, local, briefTime, type, now } = params;
  const key = `${user.userId}:${type}`;
  if (attemptCount(key, local.date) >= MAX_ATTEMPTS_PER_SLOT) return;

  const status = await getBriefSlotStatus({
    userId: user.userId,
    type,
    localDate: local.date,
    briefTime,
    timezone: local.timezone,
  });
  if (status.sent) return;

  const periodDays = type === 'weekly' ? 7 : 1;
  const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const periodEnd = new Date(now);

  try {
    const content = type === 'weekly'
      ? await generateWeeklyBrief(user.userId, local.timezone)
      : await generateDailyBrief(user.userId, local.timezone);

    let briefId: string;
    if (status.pendingBriefId) {
      briefId = status.pendingBriefId;
      await updateBriefContent({ briefId, content, periodStart, periodEnd });
    } else {
      briefId = await saveBrief({ userId: user.userId, type, content, periodStart, periodEnd });
    }

    const msg = await sendMarkdownSafe(
      (text, extra) => telegram.sendMessage(
        user.telegramId, text, extra as Parameters<Telegram['sendMessage']>[2],
      ),
      content,
    );
    if (msg) await markBriefSent(briefId, msg.message_id);
    attempts.delete(key);
    logger.info({ userId: user.userId, briefId, type }, 'Brief sent');
  } catch (err) {
    recordFailure(key, local.date);
    logger.error(
      { err, userId: user.userId, type, attempt: attemptCount(key, local.date) },
      'Brief delivery failed — will retry next tick',
    );
  }
}

export function startBriefScheduler(): void {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — brief scheduler disabled');
    return;
  }

  const telegram = new Telegram(config.TELEGRAM_BOT_TOKEN);
  let running = false;

  // Runs every minute. A user is due once their local time reaches brief_time
  // and no brief of that type has been sent since today's slot opened — so a
  // slow tick, restart or DST jump delays the brief instead of skipping it.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  cron.schedule('* * * * *', async () => {
    if (running) return; // previous tick still in flight — avoid double sends
    running = true;
    try {
      const users = await getAllBriefUsers();
      const now = new Date();

      for (const user of users) {
        try {
          const local = localNow(user.timezone, now);
          const briefTime = normalizeBriefTime(user.briefTime);
          if (local.time < briefTime) continue; // today's slot not open yet

          // Daily brief — every day once brief_time has passed
          await deliverIfDue({ telegram, user, local, briefTime, type: 'daily', now });

          // Weekly brief — Mondays only, once brief_time has passed
          if (local.weekday === 'Mon') {
            await deliverIfDue({ telegram, user, local, briefTime, type: 'weekly', now });
          }
        } catch (err) {
          logger.error({ err, userId: user.userId }, 'Brief check failed for user');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Brief scheduler tick failed');
    } finally {
      running = false;
    }
  });

  logger.info('Brief scheduler started (runs every minute, sends once brief_time has passed each local day)');
}
