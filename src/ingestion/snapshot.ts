import { query } from '../db.js';
import { logger } from '../logger.js';
import { getEthBalance, getErc20Balance } from './alchemy.js';
import { getEthBalanceBlockscout, getTokenBalancesBlockscout } from './blockscout.js';
import { BASE_USDC, BASE_BNKR, SUPPORTED_TOKENS } from './assets.js';

export async function snapshotBalances(
  apiKey: string | undefined,
  walletId: string,
  userId: string,
  walletAddress: string,
): Promise<void> {
  const snapshotAt = new Date();

  let ethBalance: number;
  let usdcBalance: number;
  let bnkrBalance: number;

  if (apiKey) {
    [ethBalance, usdcBalance, bnkrBalance] = await Promise.all([
      getEthBalance(apiKey, walletAddress),
      getErc20Balance(apiKey, walletAddress, BASE_USDC, SUPPORTED_TOKENS[BASE_USDC].decimals),
      getErc20Balance(apiKey, walletAddress, BASE_BNKR, SUPPORTED_TOKENS[BASE_BNKR].decimals),
    ]);
  } else {
    logger.warn({ walletId }, 'No ALCHEMY_API_KEY — using Blockscout for balance snapshot');
    const [eth, tokens] = await Promise.all([
      getEthBalanceBlockscout(walletAddress),
      getTokenBalancesBlockscout(walletAddress),
    ]);
    ethBalance = eth;
    usdcBalance = tokens.usdc;
    bnkrBalance = tokens.bnkr;
  }

  const rows = [
    { asset: 'ETH', balance: ethBalance },
    { asset: 'USDC', balance: usdcBalance },
    { asset: 'BNKR', balance: bnkrBalance },
  ];

  for (const row of rows) {
    await query(
      `INSERT INTO balance_snapshots (wallet_id, user_id, asset, balance, snapshot_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wallet_id, asset, snapshot_at) DO NOTHING`,
      [walletId, userId, row.asset, row.balance, snapshotAt],
    );
  }

  logger.info({ walletId, eth: ethBalance, usdc: usdcBalance, bnkr: bnkrBalance }, 'Balance snapshot stored');
}
