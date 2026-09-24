import OpenAI from 'openai';
import { query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ClassificationFailure, ClassificationResult, UnclassifiedEvent } from './types.js';
import { parseLlmClassificationResponse } from './llmParse.js';
import { MODEL_LABELS } from '../types/index.js';

const LLM_MODEL = 'gpt-4o-mini';
const LLM_BATCH_SIZE = 20;
// ~20 items × (UUID + label + confidence + one-sentence evidence) ≈ 2k tokens; leave headroom
// so the JSON is never truncated mid-array.
const LLM_MAX_OUTPUT_TOKENS = 4096;
// gpt-4o-mini pricing (per token)
const INPUT_COST_PER_TOKEN = 0.15 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000;

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

async function getDailySpendUsd(): Promise<number> {
  const res = await query<{ total: string }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
     FROM llm_spend_log
     WHERE created_at >= date_trunc('day', NOW())`,
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

// Permanent request rejections (4xx other than 429) count toward the attempt cap so a
// poison event can't retry forever; transient errors (network, 429, 5xx) don't.
function isPermanentApiError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
}

export async function classifyWithLlmDetailed(
  events: UnclassifiedEvent[],
  userId: string,
  context: Map<string, LlmContext> = new Map(),
): Promise<LlmClassificationOutcome> {
  const results = new Map<string, ClassificationResult>();
  const failures = new Map<string, ClassificationFailure>();
  if (events.length === 0) return { results, failures };

  if (!config.OPENAI_API_KEY) {
    markFailed(failures, events.map((e) => e.id), {
      countsAsAttempt: false,
      reason: 'No rule matched and LLM unavailable (no API key)',
    });
    return { results, failures };
  }

  const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

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
        model: LLM_MODEL,
        max_tokens: LLM_MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      })
      .catch((err: unknown) => {
        logger.error({ err, batchStart: i }, 'LLM classification batch failed');
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
      const costUsd = inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;
      await logSpend({ userId, model: LLM_MODEL, inputTokens, outputTokens, costUsd });
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
    for (const [id, result] of parsed.results) results.set(id, result);
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
