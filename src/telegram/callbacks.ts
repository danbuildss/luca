import type { Context } from 'telegraf';
import { ClassificationLabel, CLASSIFICATION_LABELS } from '../types/index.js';
import { applyCorrection, EventNotFoundError } from '../corrections/handler.js';
import { resolveAlert } from '../alerts/counterparty.js';
import { logger } from '../logger.js';
import type { AuthedUser } from './auth.js';

// Callback data formats:
//   label:<eventId>:<label>            — label a review event
//   skip:<eventId>                     — skip a review event (no change)
//   alert_label:<alertId>:<eventId>:<label>  — label from a counterparty alert

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
    } else if (data.startsWith('alert_label:')) {
      await handleAlertLabelCallback(ctx, user, data);
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
    await applyCorrection({
      userId: user.userId,
      eventId,
      newLabel: labelValue as ClassificationLabel,
      reason: 'Telegram review',
    });
    await ctx.answerCbQuery(`Labeled as ${labelValue} ✓`);
    await ctx.editMessageText(
      (ctx.callbackQuery?.message as { text?: string } | undefined)?.text
        ? `${(ctx.callbackQuery!.message as { text: string }).text}\n\n✅ Labeled: ${labelValue}`
        : `✅ Labeled: ${labelValue}`,
    );
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

async function handleAlertLabelCallback(ctx: Context, user: AuthedUser, data: string): Promise<void> {
  // alert_label:<alertId>:<eventId>:<label>
  const parts = data.split(':');
  if (parts.length !== 4) { await ctx.answerCbQuery('Bad callback data'); return; }
  const [, alertId, eventId, labelValue] = parts;

  if (!(CLASSIFICATION_LABELS as readonly string[]).includes(labelValue)) {
    await ctx.answerCbQuery('Invalid label');
    return;
  }

  try {
    await Promise.all([
      applyCorrection({
        userId: user.userId,
        eventId,
        newLabel: labelValue as ClassificationLabel,
        reason: 'Telegram alert response',
      }),
      resolveAlert({ alertId, userId: user.userId, status: 'labeled' }),
    ]);
    await ctx.answerCbQuery(`Labeled as ${labelValue} ✓ — future transfers auto-classify`);
    await ctx.editMessageReplyMarkup(undefined);
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      await ctx.answerCbQuery('Event not found');
    } else {
      throw err;
    }
  }
}
