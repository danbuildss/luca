import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { ClassificationLabel, CLASSIFICATION_LABELS } from '../types/index.js';
import { applyCorrection, describeRuleOutcome, EventNotFoundError } from '../corrections/handler.js';
import { resolveAlert } from '../alerts/counterparty.js';
import { labelQuestionGroup, skipQuestionGroup } from '../alerts/questions.js';
import { addGoldTransaction } from '../quality/goldset.js';
import { setFailureReason } from '../corrections/store.js';
import type { FailureReason } from '../corrections/handler.js';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { executeTool } from '../agent/tools.js';
import { saveMessage } from '../agent/context.js';
import { pendingActions, describePendingAction } from '../agent/pending.js';
import type { AuthedUser } from './auth.js';

// Confirm / Cancel keyboard for a write action the agent proposed.
export function agentConfirmKeyboard(actionId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Confirm', `agentok:${actionId}`),
      Markup.button.callback('Cancel', `agentno:${actionId}`),
    ],
  ]);
}

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
    } else if (data.startsWith('qg:')) {
      await handleQuestionGroupCallback(ctx, user, data);
    } else if (data.startsWith('qg_skip:')) {
      await skipQuestionGroup(data.slice('qg_skip:'.length), user.userId);
      await ctx.answerCbQuery('Skipped. I will ask again if more of these come in.');
      try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }
    } else if (data.startsWith('al:')) {
      await handleAlertLabelShortCallback(ctx, user, data);
    } else if (data.startsWith('alert_label:')) {
      await handleAlertLabelCallback(ctx, user, data);
    } else if (data.startsWith('gs:')) {
      await handleGoldSetLabelCallback(ctx, user, data);
    } else if (data.startsWith('gs_skip:')) {
      await handleGoldSetSkipCallback(ctx, data);
    } else if (data.startsWith('fr:')) {
      await handleFailureReasonCallback(ctx, user, data);
    } else if (data.startsWith('agentok:')) {
      await handleAgentActionCallback(ctx, user, data, true);
    } else if (data.startsWith('agentno:')) {
      await handleAgentActionCallback(ctx, user, data, false);
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
    if (note) await ctx.reply(note);
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

const LABEL_WORDS: Partial<Record<ClassificationLabel, string>> = {
  revenue: 'revenue', expense: 'expenses', internal_transfer: 'internal transfers', refund: 'refunds',
};

async function handleQuestionGroupCallback(ctx: Context, user: AuthedUser, data: string): Promise<void> {
  // qg:<groupId>:<label>
  const parts = data.split(':');
  if (parts.length !== 3) { await ctx.answerCbQuery('Bad callback data'); return; }
  const [, groupId, labelValue] = parts;
  if (!(CLASSIFICATION_LABELS as readonly string[]).includes(labelValue)) {
    await ctx.answerCbQuery('Invalid label');
    return;
  }
  const label = labelValue as ClassificationLabel;

  const answer = await labelQuestionGroup(groupId, user.userId, label);
  try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }
  if (!answer.ok) {
    await ctx.answerCbQuery(answer.reason === 'nothing_open' ? 'These are already labeled.' : 'Question not found');
    return;
  }
  await ctx.answerCbQuery('Labeled.');
  const what = answer.labeled === 1 ? 'that transfer' : `all ${answer.labeled} transfers`;
  const note = describeRuleOutcome(answer.rule);
  await ctx.reply([`Done. I labeled ${what} as ${LABEL_WORDS[label] ?? label}.`, note].filter(Boolean).join(' '));
}

async function getEventIdForAlert(alertId: string, userId: string): Promise<string | null> {
  const res = await query<{ event_id: string }>(
    `SELECT ne.id AS event_id
     FROM pending_counterparty_alerts pca
     LEFT JOIN LATERAL (
       SELECT ne2.id
       FROM normalized_events ne2
       JOIN classifications c ON c.event_id = ne2.id AND c.superseded_at IS NULL
       WHERE ne2.user_id = pca.user_id
         AND ne2.supported IS TRUE
         AND c.label = 'unknown'
         AND CASE WHEN ne2.direction = 'in' THEN ne2.from_address ELSE ne2.to_address END
             = pca.counterparty_address
       ORDER BY ne2.block_time DESC
       LIMIT 1
     ) ne ON TRUE
     WHERE pca.id = $1 AND pca.user_id = $2`,
    [alertId, userId],
  );
  return res.rows[0]?.event_id ?? null;
}

async function handleAlertLabelShortCallback(ctx: Context, user: AuthedUser, data: string): Promise<void> {
  // al:<alertId>:<label>
  const parts = data.split(':');
  if (parts.length !== 3) { await ctx.answerCbQuery('Bad callback data'); return; }
  const [, alertId, labelValue] = parts;

  if (!(CLASSIFICATION_LABELS as readonly string[]).includes(labelValue)) {
    await ctx.answerCbQuery('Invalid label');
    return;
  }

  const eventId = await getEventIdForAlert(alertId, user.userId);
  if (!eventId) {
    await ctx.answerCbQuery('No unknown event found for this alert');
    await resolveAlert({ alertId, userId: user.userId, status: 'skipped' });
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }
    return;
  }

  try {
    const [result] = await Promise.all([
      applyCorrection({
        userId: user.userId,
        eventId,
        newLabel: labelValue as ClassificationLabel,
        reason: 'Telegram alert response',
      }),
      resolveAlert({ alertId, userId: user.userId, status: 'labeled' }),
    ]);
    await ctx.answerCbQuery(`Labeled as ${labelValue}.`);
    await ctx.editMessageReplyMarkup(undefined);
    const note = describeRuleOutcome(result.rule);
    if (note) await ctx.reply(note);
    if (result.wasCorrection) {
      await ctx.reply('What did I get wrong? This helps me improve.', FAILURE_REASON_KEYBOARD(result.correctionId));
    }
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      await ctx.answerCbQuery('Event not found');
    } else {
      throw err;
    }
  }
}

async function handleAlertLabelCallback(ctx: Context, user: AuthedUser, data: string): Promise<void> {
  // alert_label:<alertId>:<eventId>:<label> — legacy format
  const parts = data.split(':');
  if (parts.length !== 4) { await ctx.answerCbQuery('Bad callback data'); return; }
  const [, alertId, eventId, labelValue] = parts;

  if (!(CLASSIFICATION_LABELS as readonly string[]).includes(labelValue)) {
    await ctx.answerCbQuery('Invalid label');
    return;
  }

  try {
    const [result] = await Promise.all([
      applyCorrection({
        userId: user.userId,
        eventId,
        newLabel: labelValue as ClassificationLabel,
        reason: 'Telegram alert response',
      }),
      resolveAlert({ alertId, userId: user.userId, status: 'labeled' }),
    ]);
    await ctx.answerCbQuery(`Labeled as ${labelValue}.`);
    await ctx.editMessageReplyMarkup(undefined);
    const note = describeRuleOutcome(result.rule);
    if (note) await ctx.reply(note);
    if (result.wasCorrection) {
      await ctx.reply('What did I get wrong? This helps me improve.', FAILURE_REASON_KEYBOARD(result.correctionId));
    }
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      await ctx.answerCbQuery('Event not found');
    } else {
      throw err;
    }
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

async function recordAgentOutcome(userId: string, content: string): Promise<void> {
  // Keep the agent's conversation history aware of what actually happened.
  try {
    await saveMessage({ userId, role: 'assistant', content });
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to record agent action outcome');
  }
}

async function handleAgentActionCallback(
  ctx: Context,
  user: AuthedUser,
  data: string,
  confirm: boolean,
): Promise<void> {
  // agentok:<actionId> | agentno:<actionId>
  const actionId = data.split(':')[1] ?? '';
  const taken = pendingActions.take(actionId, user.userId);

  if (taken.status === 'forbidden') {
    await ctx.answerCbQuery('This action belongs to someone else.');
    return;
  }
  if (taken.status !== 'ok') {
    await ctx.answerCbQuery(
      taken.status === 'expired'
        ? 'This request expired — ask me again.'
        : 'Already handled or expired.',
    );
    try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }
    return;
  }

  const { action } = taken;
  const desc = describePendingAction(action.toolName, action.args);

  if (!confirm) {
    await ctx.answerCbQuery('Cancelled');
    try { await ctx.editMessageText(`Cancelled, nothing was changed: ${desc}`); } catch { /* already edited */ }
    await recordAgentOutcome(user.userId, `(Operator cancelled the proposed action: ${desc})`);
    return;
  }

  await ctx.answerCbQuery('Working…');
  try { await ctx.editMessageReplyMarkup(undefined); } catch { /* already edited */ }

  let errorMsg: string | null = null;
  let note: string | null = null;
  try {
    const result = await executeTool(action.userId, action.toolName, action.args);
    if (result && !Array.isArray(result) && typeof result.error === 'string') {
      errorMsg = result.error;
    }
    if (result && !Array.isArray(result) && typeof result.note === 'string') {
      note = result.note;
    }
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      errorMsg = 'Transaction not found.';
    } else {
      logger.error({ err, userId: user.userId, toolName: action.toolName }, 'Confirmed agent action failed');
      errorMsg = 'Something went wrong — try again shortly.';
    }
  }

  const text = errorMsg
    ? `I could not complete this: ${desc}\n${errorMsg}`
    : `Done: ${desc}${note ? `\n${note}` : ''}`;
  try {
    await ctx.editMessageText(text);
  } catch {
    try { await ctx.reply(text); } catch (err) { logger.warn({ err }, 'Failed to report agent action result'); }
  }
  await recordAgentOutcome(
    user.userId,
    errorMsg ? `(Confirmed action failed: ${desc} — ${errorMsg})` : `(Operator confirmed and I completed: ${desc}${note ? ` ${note}` : ''})`,
  );
}
