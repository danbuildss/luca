import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ClassificationLabel, CLASSIFICATION_LABELS } from '../types/index.js';
import type { ClassificationResult, UnclassifiedEvent } from './types.js';

const LLM_MODEL = 'claude-haiku-4-5-20251001';
const LLM_BATCH_SIZE = 20;
// Haiku 4.5 pricing (per token)
const INPUT_COST_PER_TOKEN = 0.8 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 4.0 / 1_000_000;

const SYSTEM_PROMPT = `You are a financial transaction classifier for an on-chain business.
Classify each transaction into exactly one of these labels:
- revenue: payment received for goods or services sold
- expense: payment sent for goods or services purchased
- internal_transfer: movement of funds between wallets owned by the same entity
- treasury: large capital allocation to/from a treasury wallet
- gas: network fee payment (small ETH amounts for transaction costs)
- x402_income: micropayment received via the x402 HTTP payment protocol
- x402_spend: micropayment sent via the x402 HTTP payment protocol
- refund: return of a prior payment
- unknown: cannot determine purpose with reasonable confidence

Return a JSON array — one object per input transaction, in the same order:
[{"id":"<id>","label":"<label>","confidence":<0.0-1.0>,"evidence":"<one concise sentence>"}]`;

type LlmEventInput = {
  id: string;
  direction: 'in' | 'out';
  asset: string | null;
  amount: number | null;
  from: string;
  to: string | null;
  block_time: string;
};

type LlmResponseItem = {
  id: string;
  label: string;
  confidence: number;
  evidence: string;
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

export async function classifyWithLlm(
  events: UnclassifiedEvent[],
  userId: string,
): Promise<Map<string, ClassificationResult>> {
  if (!config.ANTHROPIC_API_KEY || events.length === 0) return new Map();

  const dailySpend = await getDailySpendUsd();
  if (dailySpend >= config.LLM_DAILY_SPEND_CAP_USD) {
    logger.warn(
      { dailySpend, cap: config.LLM_DAILY_SPEND_CAP_USD },
      'LLM daily spend cap reached — skipping',
    );
    return new Map();
  }

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const results = new Map<string, ClassificationResult>();

  for (let i = 0; i < events.length; i += LLM_BATCH_SIZE) {
    const batch = events.slice(i, i + LLM_BATCH_SIZE);
    const payload: LlmEventInput[] = batch.map((e) => ({
      id: e.id,
      direction: e.direction,
      asset: e.asset,
      amount: e.amount,
      from: e.from_address,
      to: e.to_address,
      block_time: e.block_time.toISOString(),
    }));

    try {
      const response = await anthropic.messages.create({
        model: LLM_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
      });

      const { input_tokens: inputTokens, output_tokens: outputTokens } = response.usage;
      const costUsd = inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;

      await logSpend({ userId, model: LLM_MODEL, inputTokens, outputTokens, costUsd });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        logger.warn('LLM returned no text block for classification batch');
        continue;
      }

      let parsed: LlmResponseItem[];
      try {
        const raw = textBlock.text
          .replace(/^```(?:json)?\n?/, '')
          .replace(/\n?```$/, '')
          .trim();
        parsed = JSON.parse(raw) as LlmResponseItem[];
      } catch {
        logger.warn({ text: textBlock.text }, 'LLM response is not valid JSON');
        continue;
      }

      for (const item of parsed) {
        const label: ClassificationLabel = (CLASSIFICATION_LABELS as readonly string[]).includes(item.label)
          ? (item.label as ClassificationLabel)
          : ClassificationLabel.UNKNOWN;
        results.set(item.id, {
          label,
          confidence: Math.min(1, Math.max(0, item.confidence ?? 0.5)),
          method: 'model',
          evidence: item.evidence ?? 'LLM classification',
        });
      }

      logger.debug(
        { batch: i / LLM_BATCH_SIZE + 1, size: batch.length, costUsd },
        'LLM classification batch complete',
      );
    } catch (err) {
      logger.error({ err, batchStart: i }, 'LLM classification batch failed');
    }
  }

  return results;
}
