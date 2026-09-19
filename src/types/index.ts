// Canonical classification labels — single source of truth.
// All code, DB CHECK constraints, and prompts must use these exact strings.
export const CLASSIFICATION_LABELS = [
  'revenue',
  'expense',
  'internal_transfer',
  'treasury',
  'gas',
  'x402_income',
  'x402_spend',
  'refund',
  'unknown',
] as const;

export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];

export const ClassificationLabel = {
  REVENUE: 'revenue',
  EXPENSE: 'expense',
  INTERNAL_TRANSFER: 'internal_transfer',
  TREASURY: 'treasury',
  GAS: 'gas',
  X402_INCOME: 'x402_income',
  X402_SPEND: 'x402_spend',
  REFUND: 'refund',
  UNKNOWN: 'unknown',
} as const satisfies Record<string, ClassificationLabel>;

// Classification methods in precedence order (lowest index = highest priority)
export const CLASSIFICATION_METHODS = [
  'deterministic', // same-wallet transfers, gas, known x402 contracts
  'counterparty',  // user corrections and counterparty rules
  'pattern',       // contract type, cadence, amount patterns
  'model',         // LLM fallback — last resort only
] as const;

export type ClassificationMethod = (typeof CLASSIFICATION_METHODS)[number];

export const SUPPORTED_CHAINS = ['base', 'solana'] as const;
export type Chain = (typeof SUPPORTED_CHAINS)[number];

export const WALLET_ROLES = ['operations', 'treasury', 'revenue', 'expenses', 'agent', 'personal'] as const;
export type WalletRole = (typeof WALLET_ROLES)[number];

export const COUNTERPARTY_ALERT_STATUSES = ['pending', 'labeled', 'skipped', 'timed_out'] as const;
export type CounterpartyAlertStatus = (typeof COUNTERPARTY_ALERT_STATUSES)[number];

// Brief aggregation: which labels combine into which brief categories
export const BRIEF_CATEGORIES = {
  revenue: ['revenue', 'x402_income'] as ClassificationLabel[],
  expenses: ['expense', 'x402_spend'] as ClassificationLabel[],
  gas: ['gas'] as ClassificationLabel[],
  internal: ['internal_transfer', 'treasury'] as ClassificationLabel[], // excluded from P&L
  unknown: ['unknown'] as ClassificationLabel[],
  refund: ['refund'] as ClassificationLabel[],
} as const;
