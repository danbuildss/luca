export const chains = ['base'] as const;
export type Chain = (typeof chains)[number];

export const assets = ['USDC', 'ETH'] as const;
export type Asset = (typeof assets)[number];

export const walletRoles = ['operations', 'treasury', 'personal', 'revenue', 'agent'] as const;
export type WalletRole = (typeof walletRoles)[number];

export const classificationLabels = [
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
export type ClassificationLabel = (typeof classificationLabels)[number];

export const confidenceLevels = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof confidenceLevels)[number];

export type MoneyAmount = {
  atomicAmount: bigint;
  decimals: number;
  asset: Asset;
};
