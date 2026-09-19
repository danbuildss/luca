import { config } from '../config.js';
import { logger } from '../logger.js';

const BASE_URL = 'https://api.bankr.bot';

export class BankrError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BankrError';
  }
}

async function bankrFetch<T>(path: string): Promise<T> {
  if (!config.BANKR_API_KEY) {
    throw new BankrError('BANKR_API_KEY not configured');
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${config.BANKR_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    logger.warn({ status: res.status, path }, 'Bankr API request failed');
    throw new BankrError(`Bankr API ${res.status}`, res.status);
  }

  return res.json() as Promise<T>;
}

export type BankrTokenPosition = {
  chain: string;
  symbol: string;
  name: string;
  balance: string;
  usd_value: number;
  contract_address: string | null;
};

export type BankrDefiPosition = {
  protocol: string;
  position_type: string; // 'liquidity', 'lending_supply', 'staking', etc.
  chain: string;
  usd_value: number;
  assets: Array<{ symbol: string; balance: string; usd_value: number }>;
};

export type BankrPortfolio = {
  total_usd: number;
  tokens: BankrTokenPosition[];
  defi: BankrDefiPosition[];
};

export type BankrWallet = {
  address: string;
  chain: string;
};

export const bankrClient = {
  getWallet: () => bankrFetch<BankrWallet>('/wallet/me'),
  getPortfolio: () => bankrFetch<BankrPortfolio>('/wallet/portfolio'),
};
