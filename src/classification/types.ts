import type { ClassificationLabel, ClassificationMethod } from '../types/index.js';

export type UnclassifiedEvent = {
  id: string;
  user_id: string;
  wallet_id: string;
  hash: string;
  log_index: number | null;
  block_time: Date;
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  direction: 'in' | 'out';
  // Active classification id at read time (a retryable failure placeholder), or null when
  // the event had none. Used to avoid overwriting anything written while we were working.
  active_classification_id?: string | null;
};

export type ClassificationResult = {
  label: ClassificationLabel;
  confidence: number;
  method: ClassificationMethod;
  evidence: string;
};

export type CounterpartyRuleRow = {
  address: string;
  label: ClassificationLabel;
  name: string | null;
  confidence: number;
  // Direction the rule applies to; null/undefined = legacy rule, applies to both directions
  direction?: 'in' | 'out' | null;
};

// Why the classifier could not produce a real label for an event.
//   countsAsAttempt = true  → a paid LLM call returned bad/missing/invalid output, or the request
//                             was permanently rejected (4xx); counts toward the max-attempt cap
//   countsAsAttempt = false → nothing was spent / transient (no key, spend cap, network, 429, 5xx);
//                             retried after a backoff without consuming an attempt
export type ClassificationFailure = {
  countsAsAttempt: boolean;
  reason: string;
};
