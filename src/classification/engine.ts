import { logger } from '../logger.js';
import { ClassificationLabel } from '../types/index.js';
import type { ClassificationMethod } from '../types/index.js';
import { classifyDeterministic } from './deterministic.js';
import { classifyByCounterparty } from './counterparty.js';
import { classifyWithLlm } from './llm.js';
import {
  getUnclassifiedEvents,
  getUserWalletAddresses,
  getCounterpartyRules,
  saveManyClassifications,
  getDistinctUserIds,
} from './store.js';

type SaveRow = {
  event_id: string;
  user_id: string;
  label: ClassificationLabel;
  confidence: number;
  method: ClassificationMethod;
  evidence: string;
};

export async function classifyPendingEvents(userId: string): Promise<number> {
  const [events, wallets, rules] = await Promise.all([
    getUnclassifiedEvents(userId),
    getUserWalletAddresses(userId),
    getCounterpartyRules(userId),
  ]);

  if (events.length === 0) return 0;

  const toSave: SaveRow[] = [];
  const llmQueue = events.filter((event) => {
    const det = classifyDeterministic(event, wallets);
    if (det) {
      toSave.push({ event_id: event.id, user_id: userId, ...det });
      return false;
    }

    const cp = classifyByCounterparty(event, rules);
    if (cp) {
      toSave.push({ event_id: event.id, user_id: userId, ...cp });
      return false;
    }

    return true;
  });

  if (llmQueue.length > 0) {
    const llmResults = await classifyWithLlm(llmQueue, userId);
    for (const event of llmQueue) {
      const result = llmResults.get(event.id) ?? {
        label: ClassificationLabel.UNKNOWN,
        confidence: 0,
        method: 'model' as ClassificationMethod,
        evidence: 'No rule matched and LLM unavailable or cap exceeded',
      };
      toSave.push({ event_id: event.id, user_id: userId, ...result });
    }
  }

  await saveManyClassifications(toSave);

  logger.info({ userId, classified: toSave.length, llmCount: llmQueue.length }, 'Classification cycle complete');
  return toSave.length;
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
