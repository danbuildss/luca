import { logger } from '../logger.js';
import { ClassificationLabel } from '../types/index.js';
import { classifyDeterministic } from './deterministic.js';
import { classifyByCounterparty } from './counterparty.js';
import { classifyWithLlmDetailed } from './llm.js';
import {
  getUnclassifiedEvents,
  getUserWalletAddresses,
  getCounterpartyRules,
  saveManyClassifications,
  getDistinctUserIds,
} from './store.js';
import type { SaveClassificationRow } from './store.js';

export async function classifyPendingEvents(userId: string): Promise<number> {
  const [events, wallets, rules] = await Promise.all([
    getUnclassifiedEvents(userId),
    getUserWalletAddresses(userId),
    getCounterpartyRules(userId),
  ]);

  if (events.length === 0) return 0;

  const toSave: SaveClassificationRow[] = [];
  const llmQueue = events.filter((event) => {
    // Optimistic concurrency: only write if nothing changed since we read the event
    const expected_active_id = event.active_classification_id ?? null;

    const det = classifyDeterministic(event, wallets);
    if (det) {
      toSave.push({ event_id: event.id, user_id: userId, ...det, expected_active_id });
      return false;
    }

    const cp = classifyByCounterparty(event, rules);
    if (cp) {
      toSave.push({ event_id: event.id, user_id: userId, ...cp, expected_active_id });
      return false;
    }

    return true;
  });

  let llmFailed = 0;
  if (llmQueue.length > 0) {
    const { results, failures } = await classifyWithLlmDetailed(llmQueue, userId);
    for (const event of llmQueue) {
      const expected_active_id = event.active_classification_id ?? null;
      const result = results.get(event.id);
      if (result) {
        // Includes genuine model-decided 'unknown' — that is a final answer, not a failure
        toSave.push({ event_id: event.id, user_id: userId, ...result, expected_active_id });
        continue;
      }
      // No usable result → retryable failure placeholder (not a terminal 'unknown')
      const failure = failures.get(event.id) ?? {
        countsAsAttempt: true,
        reason: 'LLM returned no result for this event',
      };
      llmFailed++;
      toSave.push({
        event_id: event.id,
        user_id: userId,
        label: ClassificationLabel.UNKNOWN,
        confidence: 0,
        method: 'model',
        evidence: failure.reason,
        failure,
        expected_active_id,
      });
    }
  }

  const written = await saveManyClassifications(toSave);

  logger.info(
    { userId, classified: written, skipped: toSave.length - written, llmCount: llmQueue.length, llmFailed },
    'Classification cycle complete',
  );
  return written;
}

export async function classifyAllUsers(): Promise<void> {
  const userIds = await getDistinctUserIds();
  for (const userId of userIds) {
    try {
      await classifyPendingEvents(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Classification failed for user');
    }
  }
}
