import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { ClassificationLabel, CLASSIFICATION_LABELS } from '../types/index.js';
import { applyCorrection, describeRuleOutcome, EventNotFoundError } from '../corrections/handler.js';
import { addGoldTransaction } from '../quality/goldset.js';
import { setFailureReason } from '../corrections/store.js';
import type { FailureReason } from '../corrections/handler.js';
import { logger } from '../logger.js';
import { saveMessage } from '../agent/context.js';
import type { AuthedUser } from './auth.js';
import { replyPlainWithLinks } from './format.js';

const FAILURE_REASON_KEYBOARD = (correctionId: string) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('Bad rule', `fr:${correctionId}:bad_rule`),
      Markup.button.callback('Missing counterparty', `fr:${correctionId}:missing_counterparty`),
    ],
    [
      Markup.button.callback('Bad model', `fr:${correctionId}:bad_model_inference`),
      Markup.button.callback('Missing protocol', `fr:${correctionId}:missing_protocol`),
    ],
    [
      Markup.button.callback('Bad data', `fr:${correctionId}:bad_data`),
      Markup.button.callback('Skip', `fr_skip:${correctionId}`),
    ],
  ]);

// Callback data formats:
//   label:<eventId>:<label>            — label a review event
//   skip:<eventId>                     — skip a review event (no change)
//   al:<alertId>:<label>               — label from a counterparty alert (eventId resolved server-side)
//   alert_label:<alertId>:<eventId>:<label>  — legacy format (kept for already-sent messages)
//   qg:<groupId>:<label> / qg_skip:<groupId>  — answer or skip a grouped question
//   agentok:<actionId> / agentno:<actionId>  — confirm / cancel an agent write action

// Buttons operators used to see (Confirm / Cancel, labels on Luca's questions and alerts).
// Operators now answer in chat; a button still on screen from before says so and does
// nothing. Label buttons remain only in the admin tools (/review, /goldset).
const EXPIRED_BUTTONS = ['agentok:', 'agentno:', 'qg:', 'qg_skip:', 'al:', 'alert_label:', 'alert_skip:'];
export const EXPIRED_BUTTON_REPLY = 'That button has expired. Just tell me again in chat.';

async function expiredButton(ctx: Context): Promise<void> {
  await ctx.answerCbQuery('This button has expired');
  try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }
  await ctx.reply(EXPIRED_BUTTON_REPLY);
}

export async function handleCallback(ctx: Context, user: AuthedUser): Promise<void> {
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data;
  if (!data) {
    await ctx.answerCbQuery();
    return;
  }

  try {
    if (data.startsWith('label:')) {
      await handleLabelCallback(ctx, user, data);
    } else if (data.startsWith('skip:')) {
      await handleSkipCallback(ctx, data);
    } else if (EXPIRED_BUTTONS.some((prefix) => data.startsWith(prefix))) {
      await expiredButton(ctx);
    } else if (data.startsWith('gs:')) {
      await handleGoldSetLabelCallback(ctx, user, data);
    } else if (data.startsWith('gs_skip:')) {
      await handleGoldSetSkipCallback(ctx, data);
    } else if (data.startsWith('fr:')) {
      await handleFailureReasonCallback(ctx, user, data);
    } else if (data.startsWith('fr_skip:')) {
      await ctx.answerCbQuery('Ok');
      try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }
    } else {
      await ctx.answerCbQuery('Unknown action');
    }
  } catch (err) {
    logger.error({ err, data }, 'Callback handler error');
    await ctx.answerCbQuery('Something went wrong — try again');
  }
}

async function handleLabelCallback(ctx: Context, user: AuthedUser, data: string): Promise<void> {
  // label:<eventId>:<label>
  const parts = data.split(':');
  if (parts.length !== 3) { await ctx.answerCbQuery('Bad callback data'); return; }
  const [, eventId, labelValue] = parts;

  if (!(CLASSIFICATION_LABELS as readonly string[]).includes(labelValue)) {
    await ctx.answerCbQuery('Invalid label');
    return;
  }

  try {
    const result = await applyCorrection({
      userId: user.userId,
      eventId,
      newLabel: labelValue as ClassificationLabel,
      reason: 'Telegram review',
    });
    await ctx.answerCbQuery(`Labeled as ${labelValue}.`);
    await ctx.editMessageText(
      (ctx.callbackQuery?.message as { text?: string } | undefined)?.text
        ? `${(ctx.callbackQuery!.message as { text: string }).text}\n\nLabeled as ${labelValue}.`
        : `Labeled as ${labelValue}.`,
    );
    const note = describeRuleOutcome(result.rule);
    if (note) await sendNote(ctx, user.userId, note);
    if (result.wasCorrection) {
      await ctx.reply(
        'What did I get wrong? This helps me improve.',
        FAILURE_REASON_KEYBOARD(result.correctionId),
      );
    }
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      await ctx.answerCbQuery('Event not found');
    } else {
      throw err;
    }
  }
}

async function handleSkipCallback(ctx: Context, _data: string): Promise<void> {
  // skip:<eventId>
  await ctx.answerCbQuery('Skipped');
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch {
    // message may already be edited — ignore
  }
}

async function handleGoldSetLabelCallback(ctx: Context, user: AuthedUser, data: string): Promise<void> {
  // gs:<eventId>:<label>
  const parts = data.split(':');
  if (parts.length !== 3) { await ctx.answerCbQuery('Bad callback data'); return; }
  const [, eventId, labelValue] = parts;

  if (!(CLASSIFICATION_LABELS as readonly string[]).includes(labelValue)) {
    await ctx.answerCbQuery('Invalid label');
    return;
  }

  await addGoldTransaction(user.userId, eventId, labelValue);
  await ctx.answerCbQuery(`Gold set: ${labelValue}`);
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch { /* already edited */ }
}

async function handleGoldSetSkipCallback(ctx: Context, _data: string): Promise<void> {
  // gs_skip:<eventId>
  await ctx.answerCbQuery('Skipped');
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch { /* already edited */ }
}

const VALID_FAILURE_REASONS = new Set<FailureReason>([
  'bad_rule',
  'missing_counterparty',
  'bad_model_inference',
  'missing_protocol',
  'bad_data',
]);

async function handleFailureReasonCallback(ctx: Context, user: AuthedUser, data: string): Promise<void> {
  // fr:<correctionId>:<reason>
  const parts = data.split(':');
  if (parts.length !== 3) { await ctx.answerCbQuery('Bad callback data'); return; }
  const [, correctionId, reason] = parts;

  if (!VALID_FAILURE_REASONS.has(reason as FailureReason)) {
    await ctx.answerCbQuery('Invalid reason');
    return;
  }

  await setFailureReason(correctionId, user.userId, reason as FailureReason);
  await ctx.answerCbQuery('Noted, thank you.');
  try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }
}

// What a label answer did beyond the transfer itself. It may end with a question about
// earlier transfers (each with its BaseScan link); it is kept in the conversation so a
// reply to it ("yes", "only the last two") has its context.
async function sendNote(ctx: Context, userId: string, note: string): Promise<void> {
  await replyPlainWithLinks(ctx, note);
  await recordAgentOutcome(userId, note);
}

async function recordAgentOutcome(userId: string, content: string): Promise<void> {
  // Keep the agent's conversation history aware of what actually happened.
  try {
    await saveMessage({ userId, role: 'assistant', content });
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to record agent action outcome');
  }
}
