import { Telegraf } from 'telegraf';
import { config, requireProductionConfig } from '../../src/config.js';
import { closeDb } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import type { AuthedUser } from '../../src/telegram/auth.js';
import { resolveTelegramUser, inviteUsername, revokeUsername } from '../../src/telegram/onboarding.js';
import { handleSummary } from '../../src/telegram/commands/summary.js';
import { handleReview } from '../../src/telegram/commands/review.js';
import { handleBalance } from '../../src/telegram/commands/balance.js';
import { handleQuality } from '../../src/telegram/commands/quality.js';
import { handleGoldSet } from '../../src/telegram/commands/goldset.js';
import { handleOps } from '../../src/telegram/commands/ops.js';
import { touchUserActivity } from '../../src/ops/db.js';
import { handleCallback, agentConfirmKeyboard } from '../../src/telegram/callbacks.js';
import { sendPendingAlerts } from '../../src/telegram/alerts.js';
import { replyMarkdownSafe } from '../../src/telegram/format.js';
import { UserRateLimiter, singleFlight } from '../../src/telegram/ratelimit.js';
import { describePendingAction } from '../../src/agent/pending.js';
import { generateDailyBrief, generateWeeklyBrief } from '../../src/briefs/generate.js';
import { saveBrief, markBriefSent } from '../../src/briefs/store.js';
import { runAgent } from '../../src/agent/run.js';
import { detectWorkerStale } from '../../src/health/detectors.js';
import { getDistinctUserIds } from '../../src/classification/store.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

if (!config.TELEGRAM_BOT_TOKEN) {
  logger.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// ---------------------------------------------------------------------------
// Auth — resolves the sender to a user, signing up invited beta testers on first
// contact. Replies with the refusal itself, so callers just return on null.
// ---------------------------------------------------------------------------
const NOT_INVITED_MSG =
  "Luca is in private beta and you're not on the invite list yet. Message @danbuildss to request access.";
const REVOKED_MSG =
  'Your Luca beta access has been turned off. Message @danbuildss if you think this is a mistake.';
const WELCOME_MSG = [
  "👋 Welcome to Luca, you're in.",
  '',
  "Send me the Base wallet address you want me to watch (0x…) and I'll start keeping your books.",
  'Type /start any time to see what I can do.',
].join('\n');

async function requireUser(ctx: Parameters<typeof handleSummary>[0]): Promise<AuthedUser | null> {
  const from = ctx.from;
  if (!from) return null;
  const access = await resolveTelegramUser({ id: from.id, username: from.username });
  if (access.status === 'ok') {
    if (access.created) await ctx.reply(WELCOME_MSG);
    return access.user;
  }
  const msg = access.status === 'revoked' ? REVOKED_MSG : NOT_INVITED_MSG;
  if (ctx.callbackQuery) await ctx.answerCbQuery(msg);
  else await ctx.reply(msg);
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
bot.command('start', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const helpLines = [
    `👋 Hi! I'm Luca, your on-chain financial agent.\n`,
    `/summary — P&L for the last 30 days`,
    `/review  — Label unknown transactions`,
    `/balance — Current wallet balances`,
    `/brief   — On-demand daily or weekly brief`,
    `/quality — Classification quality report`,
    `/goldset — Label transactions for regression testing`,
  ];
  if (user.role === 'admin') {
    helpLines.push(
      `/ops     — Founder ops console`,
      `/invite @user — Invite a beta tester`,
      `/revoke @user — Remove a tester's access`,
    );
  }
  await ctx.reply(helpLines.join('\n'));
});

bot.command('summary', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  void touchUserActivity(user.userId);
  const args = ctx.message.text.split(' ').slice(1);
  await handleSummary(ctx, user, args);
});

bot.command('review', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  void touchUserActivity(user.userId);
  await handleReview(ctx, user);
});

bot.command('balance', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  void touchUserActivity(user.userId);
  await handleBalance(ctx, user);
});

// On-demand brief: /brief [daily|weekly]
bot.command('brief', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;

  const args = ctx.message.text.split(' ').slice(1);
  const type = args[0] === 'weekly' ? 'weekly' : 'daily';

  void touchUserActivity(user.userId);
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

    const msg = await replyMarkdownSafe(ctx, content);
    if (msg) await markBriefSent(briefId, msg.message_id);
  } catch (err) {
    logger.error({ err, userId: user.userId }, '/brief command failed');
    await ctx.reply('Failed to generate brief — try again shortly.');
  }
});

bot.command('quality', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  void touchUserActivity(user.userId);
  await handleQuality(ctx, user);
});

bot.command('goldset', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  void touchUserActivity(user.userId);
  await handleGoldSet(ctx, user);
});

bot.command('invite', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  if (user.role !== 'admin') { await ctx.reply('⛔ Admin only.'); return; }
  const arg = ctx.message.text.split(/\s+/)[1];
  const outcome = await inviteUsername(arg, `admin:${user.telegramId}`);
  const name = `@${(arg ?? '').replace(/^@/, '')}`;
  if (outcome === 'invalid') {
    await ctx.reply('Usage: /invite @username');
  } else if (outcome === 'reactivated') {
    await ctx.reply(`✅ ${name}'s invite is active. They can message Luca now.`);
  } else {
    await ctx.reply(`✅ ${name} is invited. They can message Luca now.`);
  }
});

bot.command('revoke', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  if (user.role !== 'admin') { await ctx.reply('⛔ Admin only.'); return; }
  const arg = ctx.message.text.split(/\s+/)[1];
  const outcome = await revokeUsername(arg, `admin:${user.telegramId}`);
  const name = `@${(arg ?? '').replace(/^@/, '')}`;
  const replies = {
    invalid: 'Usage: /revoke @username',
    not_found: `No invite or user found for ${name}.`,
    admin: "Admins can't be revoked.",
    revoked: `⛔ ${name}'s access is revoked.`,
  } as const;
  await ctx.reply(replies[outcome]);
});

bot.command('ops', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const args = ctx.message.text.split(' ').slice(1);
  await handleOps(ctx, user, args);
});

// Power-user: /label <event_id> <label>
bot.command('label', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;

  void touchUserActivity(user.userId);
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
// Free-text messages — agent loop
// ---------------------------------------------------------------------------
// Each message can trigger several LLM calls: one run at a time per user,
// and at most 20 messages per 10 minutes.
const agentLimiter = new UserRateLimiter({ maxPerWindow: 20, windowMs: 10 * 60_000 });

bot.on('text', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;

  void touchUserActivity(user.userId);
  const userMessage = ctx.message.text.trim();
  if (!userMessage) return;

  const slot = agentLimiter.tryAcquire(user.userId);
  if (!slot.ok) {
    if (slot.reason === 'busy') {
      await ctx.reply("Still working on your last message — give me a moment.");
    } else {
      const mins = Math.max(1, Math.ceil(slot.retryAfterMs / 60_000));
      await ctx.reply(`You're sending messages faster than I can keep up. Try again in ~${mins} min.`);
    }
    return;
  }

  try {
    // Typing indicator while agent works
    await ctx.sendChatAction('typing');

    const { text, pendingActions } = await runAgent({ userId: user.userId, userMessage });
    await replyMarkdownSafe(ctx, text);

    // Write actions the agent proposed — executed only after the user confirms.
    for (const action of pendingActions) {
      const kb = agentConfirmKeyboard(action.id);
      await ctx.reply(
        `Confirm action?\n${describePendingAction(action.toolName, action.args)}\n\n(expires in 10 minutes)`,
        { reply_markup: kb.reply_markup },
      );
    }
  } catch (err) {
    logger.error({ err, userId: user.userId }, 'Agent run failed');
    await ctx.reply("Something went wrong — I'll look into it.");
  } finally {
    agentLimiter.release(user.userId);
  }
});

// ---------------------------------------------------------------------------
// Inline keyboard callbacks
// ---------------------------------------------------------------------------
bot.on('callback_query', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;

  // Handle alert_skip separately (no event to label)
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data ?? '';
  if (data.startsWith('alert_skip:')) {
    const alertId = data.split(':')[1];
    try {
      const { resolveAlert } = await import('../../src/alerts/counterparty.js');
      await resolveAlert({ alertId, userId: user.userId, status: 'skipped' });
      await ctx.answerCbQuery('Skipped');
    } catch (err) {
      logger.error({ err, alertId, userId: user.userId }, 'alert_skip callback failed');
      try { await ctx.answerCbQuery('Something went wrong — try again'); } catch { /* already answered */ }
      return;
    }
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

// Safety net: a stray rejected promise must not take the whole bot down.
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled promise rejection');
});

// ---------------------------------------------------------------------------
// Alert polling — checks for unsent counterparty alerts every 30s
// ---------------------------------------------------------------------------
let alertTimer: ReturnType<typeof setTimeout> | null = null;

// Alert poll and health poll both deliver alerts; never let two sends overlap
// (overlap = the same unsent alert delivered twice).
const sendPendingAlertsOnce = singleFlight(() => sendPendingAlerts(bot));

function scheduleAlertPoll() {
  alertTimer = setTimeout(() => {
    void (async () => {
      try {
        await sendPendingAlertsOnce();
      } catch (err: unknown) {
        logger.error({ err }, 'Alert polling error');
      }
      scheduleAlertPoll();
    })();
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Health polling — checks worker heartbeat every 5 min
// ---------------------------------------------------------------------------
let healthTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleHealthPoll() {
  healthTimer = setTimeout(() => {
    void (async () => {
      try {
        const userIds = await getDistinctUserIds();
        for (const userId of userIds) {
          await detectWorkerStale(userId).catch((err: unknown) =>
            logger.error({ err, userId }, 'Worker-stale check failed'));
        }
        // Worker stale alerts land in `alerts` table → delivered by deliverPendingAlerts in worker
        // But if the worker is down, we need to deliver them here instead.
        await sendPendingAlertsOnce();
      } catch (err: unknown) {
        logger.error({ err }, 'Health poll error');
      }
      scheduleHealthPoll();
    })();
  }, 5 * 60_000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  const commands = [
    { command: 'summary',  description: 'P&L for the last 30 days' },
    { command: 'balance',  description: 'Current wallet balances' },
    { command: 'brief',    description: 'On-demand financial brief' },
    { command: 'review',   description: 'Label unknown transactions' },
    { command: 'quality',  description: 'Classification quality report' },
    { command: 'goldset',  description: 'Label transactions for the test set' },
  ];

  // Delete commands for every scope that old bots may have set them on
  for (const scope of [
    { type: 'default' as const },
    { type: 'all_private_chats' as const },
    { type: 'all_group_chats' as const },
  ]) {
    try { await bot.telegram.deleteMyCommands({ scope }); } catch { /* scope may not exist */ }
  }

  await bot.telegram.setMyCommands(commands);

  scheduleAlertPoll();
  scheduleHealthPoll();

  if (config.NODE_ENV === 'production') {
    logger.info('Bot starting in polling mode (switch to webhook in production)');
  }

  await bot.launch();
  logger.info('Luca Telegram bot started');
}

process.on('SIGTERM', () => {
  void (async () => {
    logger.info('SIGTERM received — bot shutting down');
    if (alertTimer) clearTimeout(alertTimer);
    if (healthTimer) clearTimeout(healthTimer);
    bot.stop('SIGTERM');
    await closeDb();
    process.exit(0);
  })();
});

process.on('SIGINT', () => {
  void (async () => {
    if (alertTimer) clearTimeout(alertTimer);
    if (healthTimer) clearTimeout(healthTimer);
    bot.stop('SIGINT');
    await closeDb();
    process.exit(0);
  })();
});

await start();
