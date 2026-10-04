import { Telegraf, type Telegram } from 'telegraf';
import { config, requireProductionConfig } from '../../src/config.js';
import { closeDb, query } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { inviteUsername, revokeUsername } from '../../src/telegram/onboarding.js';
import { requireUser, handleStart } from '../../src/telegram/access.js';
import { handleSummary } from '../../src/telegram/commands/summary.js';
import { handleReview } from '../../src/telegram/commands/review.js';
import { handleBalance } from '../../src/telegram/commands/balance.js';
import { handleQuality } from '../../src/telegram/commands/quality.js';
import { handleGoldSet } from '../../src/telegram/commands/goldset.js';
import { handleOps } from '../../src/telegram/commands/ops.js';
import { touchUserActivity } from '../../src/ops/db.js';
import { handleCallback } from '../../src/telegram/callbacks.js';
import { replyMarkdownSafe, replyPlainWithLinks, sendPlainWithLinks } from '../../src/telegram/format.js';
import { UserRateLimiter } from '../../src/telegram/ratelimit.js';
import { generateDailyBrief, generateWeeklyBrief } from '../../src/briefs/generate.js';
import { launchWithRetry } from '../../src/telegram/launch.js';
import { setAuditNotifier, recoverAudits } from '../../src/ledger/audit-runs.js';
import { saveMessage } from '../../src/agent/context.js';
import { runAgent } from '../../src/agent/run.js';
import { detectWorkerStale } from '../../src/health/detectors.js';
import { deliverWorkerStaleAlerts } from '../../src/alerts/deliver.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

if (!config.TELEGRAM_BOT_TOKEN) {
  logger.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

const ADMIN_ONLY_MSG = 'That one is for admins only.';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
bot.command('start', (ctx) => handleStart(ctx));

bot.command('summary', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  void touchUserActivity(user.userId);
  const args = ctx.message.text.split(' ').slice(1);
  await handleSummary(ctx, user, args);
});

// Label buttons: an internal tool now. Operators answer Luca's questions in chat.
bot.command('review', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  if (user.role !== 'admin') { await ctx.reply(ADMIN_ONLY_MSG); return; }
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
    // On request: a reply, not a morning message. Not stored, so the next morning still
    // starts where the last one ended
    const content = type === 'weekly'
      ? await generateWeeklyBrief(user.userId, user.timezone)
      : await generateDailyBrief(user.userId, user.timezone);
    await replyMarkdownSafe(ctx, content);
  } catch (err) {
    logger.error({ err, userId: user.userId }, '/brief command failed');
    await ctx.reply('Failed to generate brief — try again shortly.');
  }
});

bot.command('quality', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  if (user.role !== 'admin') { await ctx.reply(ADMIN_ONLY_MSG); return; }
  void touchUserActivity(user.userId);
  await handleQuality(ctx, user);
});

bot.command('goldset', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  if (user.role !== 'admin') { await ctx.reply(ADMIN_ONLY_MSG); return; }
  void touchUserActivity(user.userId);
  await handleGoldSet(ctx, user);
});

bot.command('invite', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  if (user.role !== 'admin') { await ctx.reply(ADMIN_ONLY_MSG); return; }
  const arg = ctx.message.text.split(/\s+/)[1];
  const outcome = await inviteUsername(arg, `admin:${user.telegramId}`);
  const name = `@${(arg ?? '').replace(/^@/, '')}`;
  if (outcome === 'invalid') {
    await ctx.reply('Usage: /invite @username');
  } else if (outcome === 'reactivated') {
    await ctx.reply(`${name}'s invite is active again. They can message Luca now.`);
  } else {
    await ctx.reply(`${name} is invited. They can message Luca now.`);
  }
});

bot.command('revoke', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  if (user.role !== 'admin') { await ctx.reply(ADMIN_ONLY_MSG); return; }
  const arg = ctx.message.text.split(/\s+/)[1];
  const outcome = await revokeUsername(arg, `admin:${user.telegramId}`);
  const name = `@${(arg ?? '').replace(/^@/, '')}`;
  const replies = {
    invalid: 'Usage: /revoke @username',
    not_found: `No invite or user found for ${name}.`,
    admin: "Admins can't be revoked.",
    revoked: `${name}'s access is revoked.`,
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
  const { applyCorrection, describeRuleOutcome, EventNotFoundError } = await import('../../src/corrections/handler.js');
  try {
    const result = await applyCorrection({
      userId: user.userId,
      eventId,
      newLabel: labelValue as import('../../src/types/index.js').ClassificationLabel,
      reason: 'Telegram /label command',
    });
    const note = describeRuleOutcome(result.rule);
    await replyPlainWithLinks(ctx, [`Labeled as ${labelValue}.`, note].filter(Boolean).join('\n\n'));
    if (note) await saveMessage({ userId: user.userId, role: 'assistant', content: note });
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      await ctx.reply('I could not find that transaction.');
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

    // A change the operator asked for ends the reply with Luca's own question about it;
    // it happens only when they answer yes (src/agent/changes.ts). No buttons.
    const { text } = await runAgent({ userId: user.userId, userMessage, role: user.role });
    await replyMarkdownSafe(ctx, text);
  } catch (err) {
    logger.error({ err, userId: user.userId }, 'Agent run failed');
    await ctx.reply('Something went wrong on my side. Please try again in a moment.');
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

// Questions about transfers Luca could not place are asked in the morning message
// (src/briefs/scheduler.ts), or inside a large transfer's alert; never one by one.

// ---------------------------------------------------------------------------
// Health polling — checks worker heartbeat every 5 min
// ---------------------------------------------------------------------------
let healthTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleHealthPoll() {
  healthTimer = setTimeout(() => {
    void (async () => {
      try {
        // Admins only. Sent from here: a stopped worker cannot send it
        await detectWorkerStale();
        await deliverWorkerStaleAlerts(bot.telegram);
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
// Testers chat with Luca and see no command menu. Admins get their tools in their own
// chat only. /summary, /balance, /brief and /review still work if typed.
const ADMIN_COMMANDS = [
  { command: 'ops',     description: 'Ops console' },
  { command: 'invite',  description: 'Invite a beta tester: /invite @username' },
  { command: 'revoke',  description: 'Remove a tester: /revoke @username' },
  { command: 'quality', description: 'Classification quality report' },
  { command: 'goldset', description: 'Label transactions for the test set' },
];

async function configureCommandMenus(): Promise<void> {
  for (const scope of [
    { type: 'default' as const },
    { type: 'all_private_chats' as const },
    { type: 'all_group_chats' as const },
  ]) {
    try { await bot.telegram.deleteMyCommands({ scope }); } catch { /* scope may not exist */ }
  }

  const admins = await query<{ telegram_id: string }>(
    `SELECT telegram_id::text AS telegram_id FROM users WHERE role = 'admin'`,
  );
  for (const admin of admins.rows) {
    try {
      await bot.telegram.setMyCommands(ADMIN_COMMANDS, {
        scope: { type: 'chat', chat_id: Number(admin.telegram_id) },
      });
    } catch (err) {
      logger.warn({ err }, 'Could not set admin command menu');
    }
  }
}

async function start() {
  await configureCommandMenus();

  // Book checks run in this process; results go to whoever asked, and into their
  // conversation so a follow-up question ("which one?") has the context
  setAuditNotifier(async (requesterId, text) => {
    const u = await query<{ telegram_id: string }>(`SELECT telegram_id::text AS telegram_id FROM users WHERE id = $1`, [requesterId]);
    if (!u.rows[0]) return;
    // Plain text with tappable BaseScan links for anything the check lists
    await sendPlainWithLinks((t, x) => bot.telegram.sendMessage(Number(u.rows[0].telegram_id), t, x as Parameters<Telegram['sendMessage']>[2]), text);
    await saveMessage({ userId: requesterId, role: 'assistant', content: text });
  });
  const recovered = await recoverAudits();
  if (recovered > 0) logger.info({ recovered }, 'Book checks interrupted by the restart were picked up');

  scheduleHealthPoll();

  if (config.NODE_ENV === 'production') {
    logger.info('Bot starting in polling mode (switch to webhook in production)');
  }

  // Survives another copy of the bot polling with the same token (see src/telegram/launch.ts)
  await launchWithRetry({
    launch: () => bot.launch(() => logger.info('Luca Telegram bot connecting')),
    notifyAdmins: async (text) => {
      const admins = await query<{ telegram_id: string }>(
        `SELECT telegram_id::text AS telegram_id FROM users WHERE role = 'admin'`,
      );
      for (const admin of admins.rows) {
        await bot.telegram.sendMessage(Number(admin.telegram_id), text);
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
    log: logger,
    stopping: () => shuttingDown,
  });
}

let shuttingDown = false;

process.on('SIGTERM', () => {
  void (async () => {
    shuttingDown = true;
    logger.info('SIGTERM received — bot shutting down');
    if (healthTimer) clearTimeout(healthTimer);
    bot.stop('SIGTERM');
    await closeDb();
    process.exit(0);
  })();
});

process.on('SIGINT', () => {
  void (async () => {
    shuttingDown = true;
    if (healthTimer) clearTimeout(healthTimer);
    bot.stop('SIGINT');
    await closeDb();
    process.exit(0);
  })();
});

await start();
