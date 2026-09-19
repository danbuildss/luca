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
};
