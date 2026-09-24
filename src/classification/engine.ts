import { logger } from '../logger.js';
import { ClassificationLabel, MODEL_LABELS, type TxShape } from '../types/index.js';
import { classifyDeterministic } from './deterministic.js';
import { classifyByCounterparty } from './counterparty.js';
import { classifyWithLlmDetailed, type LlmContext } from './llm.js';
import { txShape, type TxShapeResult } from './shape.js';
import {
  getUnclassifiedEvents,
  getUserWalletAddresses,
  getCounterpartyRules,
  saveManyClassifications,
  getDistinctUserIds,
  getTransactionLegs,
  getEventsToRecheck,
  getCounterpartyHistory,
  setShapes,
  type ActiveLabel,
  type TxLeg,
} from './store.js';
import type { SaveClassificationRow } from './store.js';
import type { ClassificationResult, UnclassifiedEvent } from './types.js';

type WorkItem = {
  event: UnclassifiedEvent;
  // The automated label being re-checked; null for a transfer with no label yet (or a
  // retryable failure placeholder)
  current: ActiveLabel | null;
  shape: TxShape;
  tx: TxShapeResult;
  legs: TxLeg[];
};

function isInternalLeg(leg: TxLeg, wallets: Set<string>): boolean {
  return wallets.has(leg.from_address.toLowerCase()) && wallets.has((leg.to_address ?? '').toLowerCase());
}

// The shape a label on this movement should carry.
function legShape(leg: TxLeg, tx: TxShapeResult, wallets: Set<string>): TxShape {
  if (leg.source_key === 'gas') return 'gas';
  if (isInternalLeg(leg, wallets)) return 'internal';
  return tx.shape === 'swap' || tx.shape === 'complex' ? tx.shape : 'single';
}

function toEvent(leg: TxLeg): UnclassifiedEvent {
  return {
    id: leg.id,
    user_id: leg.user_id,
    wallet_id: leg.wallet_id,
    hash: leg.hash,
    log_index: leg.log_index,
    source_key: leg.source_key,
    block_time: leg.block_time,
    from_address: leg.from_address,
    to_address: leg.to_address,
    asset: leg.asset,
    amount: leg.amount,
    direction: leg.direction,
    active_classification_id: leg.active?.id ?? null,
  };
}

// Decided from the transaction alone, before any rule or model.
function classifyByShape(item: WorkItem, wallets: string[]): ClassificationResult | null {
  const det = classifyDeterministic(item.event, wallets);
  if (det) return { ...det, shape: item.shape };
  if (item.shape === 'swap') {
    return {
      label: ClassificationLabel.SWAP,
      confidence: 1.0,
      method: 'deterministic',
      evidence: `${item.tx.summary} in one transaction`,
      shape: 'swap',
    };
  }
  if (item.shape === 'complex') {
    return {
      label: ClassificationLabel.UNKNOWN,
      confidence: 0,
      method: 'deterministic',
      evidence: `${item.tx.summary}; needs your answer`,
      shape: 'complex',
    };
  }
  return null;
}

// An automated label that can stay as it is once its shape is known: a rule's label, or
// an AI label of a kind the AI may still choose.
function keepsLabel(current: ActiveLabel): boolean {
  if (current.method === 'counterparty' || current.method === 'pattern') return true;
  return current.method === 'model' && MODEL_LABELS.includes(current.label);
}

export async function classifyPendingEvents(userId: string): Promise<number> {
  const [pending, wallets, rules, recheckHashes] = await Promise.all([
    getUnclassifiedEvents(userId),
    getUserWalletAddresses(userId),
    getCounterpartyRules(userId),
    getEventsToRecheck(userId),
  ]);
  if (pending.length === 0 && recheckHashes.length === 0) return 0;

  const walletSet = new Set(wallets.map((a) => a.toLowerCase()));
  const hashes = [...new Set([...pending.map((e) => e.hash.toLowerCase()), ...recheckHashes])];
  const legsByHash = await getTransactionLegs(userId, hashes);

  // Work: every transfer without a label, plus automated labels whose transaction now
  // looks different (a leg arrived later, or the label predates whole-transaction checks)
  const work = new Map<string, WorkItem>();
  for (const [hash, legs] of legsByHash) {
    const tx = txShape(legs, wallets);
    for (const leg of legs) {
      if (leg.supported !== true) continue;
      const shape = legShape(leg, tx, walletSet);
      const a = leg.active;
      if (a && a.source === null && a.shape !== shape) {
        work.set(leg.id, { event: toEvent(leg), current: a, shape, tx, legs: legsByHash.get(hash) ?? [] });
      }
    }
  }
  for (const e of pending) {
    const legs = legsByHash.get(e.hash.toLowerCase()) ?? [];
    const tx = txShape(legs, wallets);
    const leg = legs.find((l) => l.id === e.id);
    const shape = leg ? legShape(leg, tx, walletSet) : 'single';
    work.set(e.id, { event: e, current: null, shape, tx, legs });
  }

  const toSave: SaveClassificationRow[] = [];
  const shapeOnly: Array<{ id: string; shape: TxShape }> = [];
  const save = (item: WorkItem, result: ClassificationResult): void => {
    const c = item.current;
    if (c && c.label === result.label && c.method === result.method) {
      shapeOnly.push({ id: c.id, shape: result.shape ?? item.shape });
      return;
    }
    toSave.push({
      event_id: item.event.id,
      user_id: userId,
      ...result,
      shape: result.shape ?? item.shape,
      expected_active_id: item.current?.id ?? item.event.active_classification_id ?? null,
    });
  };

  const llmQueue: WorkItem[] = [];
  for (const item of work.values()) {
    const byShape = classifyByShape(item, wallets);
    if (byShape) { save(item, byShape); continue; }

    if (item.current && keepsLabel(item.current)) {
      shapeOnly.push({ id: item.current.id, shape: item.shape });
      continue;
    }

    const cp = classifyByCounterparty(item.event, rules);
    if (cp) { save(item, { ...cp, shape: item.shape }); continue; }

    llmQueue.push(item);
  }

  let llmFailed = 0;
  if (llmQueue.length > 0) {
    const context = await buildLlmContext(userId, llmQueue);
    const { results, failures } = await classifyWithLlmDetailed(llmQueue.map((i) => i.event), userId, context);
    for (const item of llmQueue) {
      const result = results.get(item.event.id);
      if (result) {
        // Includes genuine model-decided 'unknown' — that is a final answer, not a failure
        save(item, { ...result, shape: item.shape });
        continue;
      }
      // No usable result → retryable failure placeholder (not a terminal 'unknown')
      const failure = failures.get(item.event.id) ?? {
        countsAsAttempt: true,
        reason: 'LLM returned no result for this event',
      };
      llmFailed++;
      toSave.push({
        event_id: item.event.id,
        user_id: userId,
        label: ClassificationLabel.UNKNOWN,
        confidence: 0,
        method: 'model',
        evidence: failure.reason,
        failure,
        expected_active_id: item.current?.id ?? item.event.active_classification_id ?? null,
      });
    }
  }

  const written = await saveManyClassifications(toSave);
  await setShapes(shapeOnly);

  logger.info(
    {
      userId, classified: written, skipped: toSave.length - written, rechecked: shapeOnly.length,
      llmCount: llmQueue.length, llmFailed,
    },
    'Classification cycle complete',
  );
  return written;
}

// What the AI sees besides the transfer: the rest of its transaction, and how this
// address was labeled before.
async function buildLlmContext(userId: string, items: WorkItem[]): Promise<Map<string, LlmContext>> {
  const counterparty = (e: UnclassifiedEvent): string | null =>
    (e.direction === 'in' ? e.from_address : e.to_address)?.toLowerCase() ?? null;
  const addresses = [...new Set(items.map((i) => counterparty(i.event)).filter((a): a is string => a !== null))];
  const history = await getCounterpartyHistory(userId, addresses);

  const out = new Map<string, LlmContext>();
  for (const item of items) {
    const others = item.legs.filter((l) => l.id !== item.event.id && (l.supported === true || l.source_key === 'gas'));
    const cp = counterparty(item.event);
    out.set(item.event.id, {
      same_transaction: others.map((l) => ({
        kind: l.source_key === 'gas' ? 'network_fee' : 'transfer',
        direction: l.direction,
        asset: l.asset,
        amount: l.amount,
      })),
      counterparty_history: cp ? history.get(cp) ?? { count: 0, labels: {} } : { count: 0, labels: {} },
    });
  }
  return out;
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
