import { query } from '../db.js';
import { logger } from '../logger.js';
import { getEthBalance, getUsdcBalance, USDC_BASE } from './alchemy.js';

export async function snapshotBalances(
  apiKey: string,
  walletId: string,
  userId: string,
  walletAddress: string,
): Promise<void> {
  const snapshotAt = new Date();

  const [ethBalance, usdcBalance] = await Promise.all([
    getEthBalance(apiKey, walletAddress),
    getUsdcBalance(apiKey, walletAddress),
  ]);

  const rows = [
    { asset: 'ETH', balance: ethBalance },
    { asset: 'USDC', balance: usdcBalance, contract: USDC_BASE },
  ];

  for (const row of rows) {
    await query(
      `INSERT INTO balance_snapshots (wallet_id, user_id, asset, balance, snapshot_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wallet_id, asset, snapshot_at) DO NOTHING`,
      [walletId, userId, row.asset, row.balance, snapshotAt],
    );
  }

  logger.info(
    { walletId, eth: ethBalance, usdc: usdcBalance },
    'Balance snapshot stored',
  );
}
