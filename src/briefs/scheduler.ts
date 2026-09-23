import cron from 'node-cron';
import { Telegram } from 'telegraf';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getAllBriefUsers, saveBrief, markBriefSent } from './store.js';
import { generateDailyBrief, generateWeeklyBrief } from './generate.js';

// Returns the current HH:MM in a given IANA timezone
function localHHMM(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
    }).format(new Date()).replace(/^24:/, '00:'); // midnight edge case
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    }).format(new Date()).replace(/^24:/, '00:');
  }
}

// Returns true when today (in the user's timezone) is a Monday
function isMonday(timezone: string): boolean {
  try {
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone })
      .format(new Date());
    return day === 'Mon';
  } catch {
    return new Date().getDay() === 1;
  }
}

async function sendBrief(params: {
  telegram: Telegram;
  telegramId: number;
  userId: string;
  type: 'daily' | 'weekly';
  content: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<void> {
  const briefId = await saveBrief({
    userId: params.userId,
    type: params.type,
    content: params.content,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
  });

  try {
    const msg = await params.telegram.sendMessage(params.telegramId, params.content, {
      parse_mode: 'Markdown',
    });
    await markBriefSent(briefId, msg.message_id);
  } catch (err) {
    logger.error({ err, briefId, userId: params.userId }, 'Failed to send brief via Telegram');
  }
}

export function startBriefScheduler(): void {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — brief scheduler disabled');
    return;
  }

  const telegram = new Telegram(config.TELEGRAM_BOT_TOKEN);

  // Runs every minute; each user's brief fires when their local time matches brief_time
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  cron.schedule('* * * * *', async () => {
    try {
      const users = await getAllBriefUsers();
      const now = new Date();
      const dayEnd = new Date(now);
      const weekEnd = new Date(now);
      const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      for (const user of users) {
        const localTime = localHHMM(user.timezone);
        if (localTime !== user.briefTime) continue;

        // Daily brief — every day at brief_time
        try {
          const content = await generateDailyBrief(user.userId);
          await sendBrief({
            telegram,
            telegramId: user.telegramId,
            userId: user.userId,
            type: 'daily',
            content,
            periodStart: dayStart,
            periodEnd: dayEnd,
          });
          logger.info({ userId: user.userId }, 'Daily brief sent');
        } catch (err) {
          logger.error({ err, userId: user.userId }, 'Daily brief generation failed');
        }

        // Weekly brief — Mondays only at brief_time
        if (isMonday(user.timezone)) {
          try {
            const content = await generateWeeklyBrief(user.userId);
            await sendBrief({
              telegram,
              telegramId: user.telegramId,
              userId: user.userId,
              type: 'weekly',
              content,
              periodStart: weekStart,
              periodEnd: weekEnd,
            });
            logger.info({ userId: user.userId }, 'Weekly brief sent');
          } catch (err) {
            logger.error({ err, userId: user.userId }, 'Weekly brief generation failed');
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Brief scheduler tick failed');
    }
  });

  logger.info('Brief scheduler started (runs every minute, fires at each user\'s brief_time)');
}
