import { query } from '../db.js';
import { logger } from '../logger.js';
import { bankrClient, BankrError, type BankrDefiPosition, type BankrTokenPosition } from './client.js';
import { config } from '../config.js';

export type PortfolioSummary = {
  totalUsd: number;
  topTokens: BankrTokenPosition[];
  defiPositions: BankrDefiPosition[];
  available: boolean;
};

// Returns Bankr portfolio enrichment for a user.
// Fails silently — if Bankr is down or unconfigured, returns available: false
// so callers can still show our own balance snapshots.
export async function getBankrPortfolio(userId: string): Promise<PortfolioSummary> {
  const unavailable: PortfolioSummary = { totalUsd: 0, topTokens: [], defiPositions: [], available: false };

  if (!config.BANKR_API_KEY) return unavailable;

  // Only call Bankr for users who have a stored bankr_wallet_address
  // For V1, if not set, we skip rather than returning a wallet mismatch
  const userRow = await query<{ bankr_wallet_address: string | null }>(
    `SELECT bankr_wallet_address FROM users WHERE id = $1`,
    [userId],
  ).catch(() => null);

  // If the column doesn't exist yet (pre-migration), skip gracefully
  if (!userRow || userRow.rows.length === 0 || !userRow.rows[0].bankr_wallet_address) {
    return unavailable;
  }

  try {
    const portfolio = await bankrClient.getPortfolio();
    const topTokens = portfolio.tokens
      .filter((t) => t.usd_value >= 1)
      .sort((a, b) => b.usd_value - a.usd_value)
      .slice(0, 5);

    return {
      totalUsd: portfolio.total_usd,
      topTokens,
      defiPositions: portfolio.defi,
      available: true,
    };
  } catch (err) {
    if (err instanceof BankrError) {
      logger.warn({ userId, status: err.status }, 'Bankr portfolio fetch skipped');
    } else {
      logger.error({ err, userId }, 'Bankr portfolio unexpected error');
    }
    return unavailable;
  }
}
