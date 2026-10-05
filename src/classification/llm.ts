import { createHash } from 'crypto';
import OpenAI from 'openai';
import { query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ClassificationFailure, ClassificationResult, UnclassifiedEvent } from './types.js';
import { parseLlmClassificationResponse } from './llmParse.js';
import { MODEL_LABELS } from '../types/index.js';
import { CAP_PRICE_PER_MTOK, classifierModel, llmCallCost, llmClientOptions, usesGateway } from '../llm/client.js';

const LLM_BATCH_SIZE = 20;
// No output token limit is sent: ~20 items × (UUID + label + confidence + one-sentence
// evidence) ≈ 2k tokens, well inside every model's default, and a reasoning model spends
// part of any limit on reasoning, which would truncate the JSON mid-array.

const SYSTEM_PROMPT = `You are a financial transaction classifier for an on-chain business.
Network fees, transfers between the operator's own wallets and swaps are already handled
before you see anything. Classify each remaining transfer into exactly one of these labels:
- revenue: payment received for goods or services sold
- expense: payment sent for goods or services purchased
- treasury: large capital allocation to/from a treasury wallet
- x402_income: micropayment received via the x402 HTTP payment protocol
- x402_spend: micropayment sent via the x402 HTTP payment protocol
- refund: return of a prior payment
- unknown: cannot determine purpose with reasonable confidence

Each transfer comes with "same_transaction" (the other movements in its transaction) and
"counterparty_history" (how many earlier transfers with this address there were, and how
they were labeled). Use them as evidence. Prefer unknown over a guess.

Return a JSON object with a "results" array — one object per input transaction, in the same order,
copying each "id" exactly:
{"results":[{"id":"<id>","label":"<label>","confidence":<0.0-1.0>,"evidence":"<one concise sentence>"}]}`;

// A fingerprint of the instructions above: changes by itself whenever they change, so each
// AI label records which version of them it was made with
export const PROMPT_VERSION = createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 12);

// Evidence beyond the transfer itself (built in src/classification/engine.ts)
export type LlmContext = {
  same_transaction: Array<{ kind: 'transfer' | 'network_fee'; direction: 'in' | 'out'; asset: string | null; amount: number | null }>;
  counterparty_history: { count: number; labels: Partial<Record<string, number>> };
};

type LlmEventInput = {
  id: string;
  direction: 'in' | 'out';
  asset: string | null;
  amount: number | null;
  from: string;
  to: string | null;
  block_time: string;
} & Partial<LlmContext>;

export type LlmClassificationOutcome = {
  results: Map<string, ClassificationResult>;
  // Events that could not be classified — saved as retryable failure placeholders
  failures: Map<string, ClassificationFailure>;
};

// Today's AI spend for the cap. Classification calls on a model with no known price are
// logged at $0 (so the cost figures show them as unpriced) and counted here at the dearest
// listed price, so the cap still holds on any model.
async function getDailySpendUsd(): Promise<number> {
  const res = await query<{ total: string }>(
    `SELECT COALESCE(SUM(CASE WHEN purpose = 'classification' AND cost_usd = 0
                              THEN (input_tokens * $1::numeric + output_tokens * $2::numeric) / 1000000
                              ELSE cost_usd END), 0)::text AS total
     FROM llm_spend_log
     WHERE created_at >= date_trunc('day', NOW())`,
    [CAP_PRICE_PER_MTOK.input, CAP_PRICE_PER_MTOK.output],
  );
  return parseFloat(res.rows[0].total);
}

async function logSpend(params: {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): Promise<void> {
  await query(
    `INSERT INTO llm_spend_log (user_id, model, input_tokens, output_tokens, cost_usd, purpose)
     VALUES ($1, $2, $3, $4, $5, 'classification')`,
    [params.userId, params.model, params.inputTokens, params.outputTokens, params.costUsd],
  );
}

function markFailed(
  failures: Map<string, ClassificationFailure>,
  ids: Iterable<string>,
  failure: ClassificationFailure,
): void {
  for (const id of ids) failures.set(id, failure);
}

// Permanent request rejections (4xx) count toward the attempt cap so a poison event can't
// retry forever. Transient errors (network, 429, 5xx) don't, and neither do rejections of
// the key or the model (401, 403, 404): those are the provider's settings, not the events,
// and must not use up the attempts of every event waiting to be labelled.
export function isPermanentApiError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && ![401, 403, 404, 429].includes(status);
}

export async function classifyWithLlmDetailed(
  events: UnclassifiedEvent[],
  userId: string,
  context: Map<string, LlmContext> = new Map(),
): Promise<LlmClassificationOutcome> {
  const results = new Map<string, ClassificationResult>();
  const failures = new Map<string, ClassificationFailure>();
  if (events.length === 0) return { results, failures };

  const clientOptions = llmClientOptions({ timeout: 60_000, maxRetries: 1 });
  if (!clientOptions) {
    markFailed(failures, events.map((e) => e.id), {
      countsAsAttempt: false,
      reason: 'No rule matched and LLM unavailable (no API key)',
    });
    return { results, failures };
  }

  // The same provider as the chat agent (src/llm/client.ts). The client's default is a
  // 10-minute timeout with 2 retries; a stuck call must not hold up the worker cycle. A
  // failed batch is retried next cycle (not counted).
  const openai = new OpenAI(clientOptions);
  const model = classifierModel();

  for (let i = 0; i < events.length; i += LLM_BATCH_SIZE) {
    const batch = events.slice(i, i + LLM_BATCH_SIZE);
    const batchIds = batch.map((e) => e.id);

    const dailySpend = await getDailySpendUsd();
    if (dailySpend >= config.LLM_DAILY_SPEND_CAP_USD) {
      logger.warn(
        { dailySpend, cap: config.LLM_DAILY_SPEND_CAP_USD },
        'LLM daily spend cap reached — skipping',
      );
      markFailed(failures, events.slice(i).map((e) => e.id), {
        countsAsAttempt: false,
        reason: 'No rule matched and LLM daily spend cap reached',
      });
      break;
    }

    const payload: LlmEventInput[] = batch.map((e) => ({
      id: e.id,
      direction: e.direction,
      asset: e.asset,
      amount: e.amount,
      from: e.from_address,
      to: e.to_address,
      block_time: e.block_time.toISOString(),
      ...context.get(e.id),
    }));

    const response = await openai.chat.completions
      .create({
        model,
        // JSON mode on OpenAI; a gateway may not pass it on for every model, and the
        // prompt asks for JSON anyway (the parser also accepts it in a code fence)
        ...(usesGateway() ? {} : { response_format: { type: 'json_object' as const } }),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      })
      .catch((err: unknown) => {
        logger.error({ err, batchStart: i, model }, 'LLM classification batch failed');
        markFailed(failures, batchIds, {
          countsAsAttempt: isPermanentApiError(err),
          reason: 'LLM request failed',
        });
        return null;
      });
    if (!response) continue;

    try {
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
      const costUsd = llmCallCost(model, inputTokens, outputTokens);
      await logSpend({ userId, model, inputTokens, outputTokens, costUsd });
    } catch (err) {
      logger.error({ err }, 'Failed to log LLM spend');
    }

    const choice = response.choices[0];
    const text = choice?.message?.content ?? '';
    if (choice?.finish_reason === 'length') {
      logger.warn({ batchStart: i, size: batch.length }, 'LLM classification output truncated');
    }
    if (!text) {
      logger.warn('LLM returned empty content for classification batch');
      markFailed(failures, batchIds, { countsAsAttempt: true, reason: 'LLM returned empty output' });
      continue;
    }

    const parsed = parseLlmClassificationResponse(text, batchIds, MODEL_LABELS);
    if (parsed.malformed) {
      logger.warn({ text: text.slice(0, 500) }, 'LLM response is not valid JSON');
    } else if (parsed.invalidIds.length > 0) {
      logger.warn(
        { batchStart: i, invalid: parsed.invalidIds.length },
        'LLM response missing or invalid for some items',
      );
    }
    // Provenance (migration 030): which model, which instructions, and what it was shown
    const shown = new Map(payload.map((p) => [p.id, p]));
    for (const [id, result] of parsed.results) {
      const inputs: Record<string, unknown> = { ...shown.get(id) };
      delete inputs.id;
      results.set(id, { ...result, model, prompt_version: PROMPT_VERSION, inputs });
    }
    markFailed(failures, parsed.invalidIds, {
      countsAsAttempt: true,
      reason: parsed.malformed ? 'LLM output was not valid JSON' : 'LLM output missing or invalid for this item',
    });

    logger.debug(
      { batch: i / LLM_BATCH_SIZE + 1, size: batch.length, ok: parsed.results.size },
      'LLM classification batch complete',
    );
  }

  return { results, failures };
}

// Backward-compatible wrapper: successful classifications only.
export async function classifyWithLlm(
  events: UnclassifiedEvent[],
  userId: string,
): Promise<Map<string, ClassificationResult>> {
  const { results } = await classifyWithLlmDetailed(events, userId);
  return results;
}
