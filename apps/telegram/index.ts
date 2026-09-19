import { Telegraf } from 'telegraf';
import { config, requireProductionConfig } from '../../src/config.js';
import { closeDb } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { getUserByTelegramId } from '../../src/telegram/auth.js';
import { handleSummary } from '../../src/telegram/commands/summary.js';
import { handleReview } from '../../src/telegram/commands/review.js';
import { handleBalance } from '../../src/telegram/commands/balance.js';
import { handleCallback } from '../../src/telegram/callbacks.js';
import { sendPendingAlerts } from '../../src/telegram/alerts.js';
import { generateDailyBrief, generateWeeklyBrief } from '../../src/briefs/generate.js';
import { saveBrief, markBriefSent } from '../../src/briefs/store.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

if (!config.TELEGRAM_BOT_TOKEN) {
  logger.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// ---------------------------------------------------------------------------
// Auth middleware — resolves telegram_id → user_id for every update
// ---------------------------------------------------------------------------
async function requireUser(ctx: Parameters<typeof handleSummary>[0]) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return null;
  return getUserByTelegramId(telegramId);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
bot.command('start', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) {
    await ctx.reply("You're not registered with Luca yet. Contact the admin to get set up.");
    return;
  }
  await ctx.reply(
    `👋 Hi! I'm Luca, your on-chain financial agent.\n\n` +
    `/summary — P&L for the last 30 days\n` +
    `/review  — Label unknown transactions\n` +
    `/balance — Current wallet balances\n` +
    `/brief   — On-demand daily or weekly brief`,
  );
});

bot.command('summary', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) { await ctx.reply("You're not registered."); return; }
  const args = ctx.message.text.split(' ').slice(1);
  await handleSummary(ctx, user, args);
});

bot.command('review', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) { await ctx.reply("You're not registered."); return; }
  await handleReview(ctx, user);
});

bot.command('balance', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) { await ctx.reply("You're not registered."); return; }
  await handleBalance(ctx, user);
});

// On-demand brief: /brief [daily|weekly]
bot.command('brief', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) { await ctx.reply("You're not registered."); return; }

  const args = ctx.message.text.split(' ').slice(1);
  const type = args[0] === 'weekly' ? 'weekly' : 'daily';

  await ctx.reply(`Generating ${type} brief…`);
  try {
    const now = new Date();
    const periodDays = type === 'weekly' ? 7 : 1;
    const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const content = type === 'weekly'
      ? await generateWeeklyBrief(user.userId)
      : await generateDailyBrief(user.userId);

    const briefId = await saveBrief({
      userId: user.userId,
      type,
      content,
      periodStart,
      periodEnd: now,
    });

    const msg = await ctx.reply(content, { parse_mode: 'Markdown' });
    await markBriefSent(briefId, msg.message_id);
  } catch (err) {
    logger.error({ err, userId: user.userId }, '/brief command failed');
    await ctx.reply('Failed to generate brief — try again shortly.');
  }
});

// Power-user: /label <event_id> <label>
bot.command('label', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) { await ctx.reply("You're not registered."); return; }

  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    await ctx.reply('Usage: /label <event_id> <label>');
    return;
  }
  const [, eventId, labelValue] = parts;
  const { CLASSIFICATION_LABELS } = await import('../../src/types/index.js');
  if (!(CLASSIFICATION_LABELS as readonly string[]).includes(labelValue)) {
    await ctx.reply(`Invalid label. Valid: ${CLASSIFICATION_LABELS.join(', ')}`);
    return;
  }
  const { applyCorrection, EventNotFoundError } = await import('../../src/corrections/handler.js');
  try {
    await applyCorrection({
      userId: user.userId,
      eventId,
      newLabel: labelValue as import('../../src/types/index.js').ClassificationLabel,
      reason: 'Telegram /label command',
    });
    await ctx.reply(`✅ Labeled as ${labelValue}`);
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      await ctx.reply('Event not found.');
    } else {
      throw err;
    }
  }
});

// ---------------------------------------------------------------------------
// Inline keyboard callbacks
// ---------------------------------------------------------------------------
bot.on('callback_query', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) { await ctx.answerCbQuery("You're not registered."); return; }

  // Handle alert_skip separately (no event to label)
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data ?? '';
  if (data.startsWith('alert_skip:')) {
    const alertId = data.split(':')[1];
    const { resolveAlert } = await import('../../src/alerts/counterparty.js');
    await resolveAlert({ alertId, userId: user.userId, status: 'skipped' });
    await ctx.answerCbQuery('Skipped');
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }
    return;
  }

  await handleCallback(ctx, user);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
bot.catch((err, ctx) => {
  logger.error({ err, update: ctx.update }, 'Unhandled bot error');
});

// ---------------------------------------------------------------------------
// Alert polling — checks for unsent counterparty alerts every 30s
// ---------------------------------------------------------------------------
let alertTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAlertPoll() {
  alertTimer = setTimeout(async () => {
    try {
      await sendPendingAlerts(bot);
    } catch (err) {
      logger.error({ err }, 'Alert polling error');
    }
    scheduleAlertPoll();
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  scheduleAlertPoll();

  if (config.NODE_ENV === 'production') {
    // Webhook mode in production — set up externally via setWebhook
    logger.info('Bot starting in polling mode (switch to webhook in production)');
  }

  await bot.launch();
  logger.info('Luca Telegram bot started');
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — bot shutting down');
  if (alertTimer) clearTimeout(alertTimer);
  bot.stop('SIGTERM');
  await closeDb();
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (alertTimer) clearTimeout(alertTimer);
  bot.stop('SIGINT');
  await closeDb();
  process.exit(0);
});

await start();
