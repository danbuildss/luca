import { query } from '../db.js';
import { logger } from '../logger.js';
import { llmCallCost } from '../llm/client.js';

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
      [userId, model, input, output, llmCallCost(model, input, output)],
    );
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to log agent spend');
  }
}
