import { query } from '../db.js';
import { logger } from '../logger.js';

// USD per million tokens [input, output] for models with a published price. Checked in
// order, so a more specific name comes before its prefix. A model not listed is logged
// with its tokens at $0 and shows up as unpriced in the AI cost figures.
const PRICES_PER_MTOK: Array<[prefix: string, input: number, output: number]> = [
  ['gpt-4o-mini', 0.15, 0.6],
  ['gpt-4o', 2.5, 10],
];

export function agentCallCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES_PER_MTOK.find(([prefix]) => model.startsWith(prefix));
  if (!price) return 0;
  return (inputTokens * price[1] + outputTokens * price[2]) / 1_000_000;
}

// One row per chat completion. Never throws: a logging failure must not cost the answer.
export async function logAgentSpend(
  userId: string,
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): Promise<void> {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  try {
    await query(
      `INSERT INTO llm_spend_log (user_id, model, input_tokens, output_tokens, cost_usd, purpose)
       VALUES ($1, $2, $3, $4, $5, 'agent')`,
      [userId, model, input, output, agentCallCost(model, input, output)],
    );
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to log agent spend');
  }
}
