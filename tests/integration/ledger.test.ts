// Integration: raw evidence, gas, token-log cross-check, degraded re-reads and the hourly
// balance check (src/ledger/reconcile.ts), against real Postgres and a simulated chain.
// See tests/integration/helpers/db.ts for how to run.
import { it, expect, vi, beforeEach, describe } from 'vitest';

vi.mock('../../src/ingestion/alchemy.js', async (importOriginal) =>
  (await import('./helpers/chain.js')).alchemyMock(await importOriginal<Record<string, unknown>>()));
vi.mock('../../src/ingestion/blockscout.js', async (importOriginal) =>
  (await import('./helpers/chain.js')).blockscoutMock(await importOriginal<Record<string, unknown>>()));
vi.mock('../../src/ingestion/price.js', () => ({
  enrichUsdValue: vi.fn(() => Promise.resolve({ usd_value: null, price_source: null, price_at: null })),
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
}));
vi.mock('../../src/classification/llm.js', () => ({
  classifyWithLlmDetailed: vi.fn((events: Array<{ id: string }>) => Promise.resolve({
    results: new Map(),
    failures: new Map(events.map((e) => [e.id, { countsAsAttempt: false, reason: 'llm stubbed' }])),
  })),
  classifyWithLlm: vi.fn(() => Promise.resolve(new Map())),
}));

import { describeDb, useIntegrationDb, seedUserWithWallet, sql, addr } from './helpers/db.js';
import { chain, resetChain, usdcTransfer, ethTransfer, sentTx, spamTransfer, USDC } from './helpers/chain.js';
import { syncWallet, getActiveWatchJobs } from '../../src/ingestion/ingest.js';
import { reconcileWallet, getWalletsDueForReconciliation } from '../../src/ledger/reconcile.js';
import { getLedgerStatus } from '../../src/ledger/status.js';
import { classifyPendingEvents } from '../../src/classification/engine.js';

async function sync(walletId: string): Promise<void> {
  const job = (await getActiveWatchJobs()).find((j) => j.wallet_id === walletId)!;
  await syncWallet(job, 'key');
}

async function reconcile(walletId: string) {
  await sql(`UPDATE watch_jobs SET last_reconciled_at = NULL WHERE wallet_id = $1`, [walletId]);
  const w = (await getWalletsDueForReconciliation()).find((x) => x.wallet_id === walletId)!;
  return reconcileWallet(w, 'key');
}

async function jobRow(walletId: string) {
  const rows = await sql<{ ledger_status: string; incomplete_since_block: string | null; last_block: string }>(
    `SELECT ledger_status, incomplete_since_block::text, last_block::text FROM watch_jobs WHERE wallet_id = $1`,
    [walletId],
  );
  return rows[0];
}

describeDb('ledger proof (integration)', () => {
  useIntegrationDb();
  beforeEach(() => resetChain());

  describe('raw evidence and gas', () => {
    it('stores exact amounts and a gas entry including the L1 fee, and the books match the chain', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const w = wallet.address;
      const cp = addr();
      usdcTransfer(w, { block: 900, from: cp, to: w, raw: 100_000_000n });
      ethTransfer(w, { block: 905, from: cp, to: w, wei: 10n ** 16n });
      const tx = sentTx(w, { block: 910, gasUsed: 50_000n, gasPrice: 2_000_000n, l1Fee: 7_777n });
      usdcTransfer(w, { block: 910, from: w, to: cp, raw: 40_000_000n, txHash: tx.hash });

      await sync(wallet.id);

      const gas = await sql<{ raw_amount: string; to_address: string | null }>(
        `SELECT raw_amount::text, to_address FROM normalized_events WHERE wallet_id = $1 AND source_key = 'gas'`,
        [wallet.id],
      );
      expect(gas).toEqual([{ raw_amount: (50_000n * 2_000_000n + 7_777n).toString(), to_address: null }]);
      const raw = await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM raw_transfers WHERE wallet_id = $1`, [wallet.id]);
      expect(raw[0].n).toBe(3);

      await classifyPendingEvents(user.id);
      const label = await sql<{ label: string; method: string }>(
        `SELECT c.label::text, c.method FROM classifications c JOIN normalized_events ne ON ne.id = c.event_id
         WHERE ne.wallet_id = $1 AND ne.source_key = 'gas' AND c.superseded_at IS NULL`,
        [wallet.id],
      );
      expect(label).toEqual([{ label: 'gas', method: 'deterministic' }]);

      const outcomes = await reconcile(wallet.id);
      expect(outcomes.map((o) => o.status)).toEqual(['ok', 'ok', 'ok']);
      expect((await jobRow(wallet.id)).ledger_status).toBe('complete');

      const cps = await sql<{ asset: string; block_number: string; balance_raw: string }>(
        `SELECT asset, block_number::text, balance_raw::text FROM ledger_checkpoints WHERE wallet_id = $1 ORDER BY asset`,
        [wallet.id],
      );
      expect(cps).toEqual([
        { asset: 'BNKR', block_number: '990', balance_raw: '0' },
        { asset: 'ETH', block_number: '990', balance_raw: (10n ** 16n - tx.fee).toString() },
        { asset: 'USDC', block_number: '990', balance_raw: '60000000' },
      ]);
    });

    it('records only gas for a failed transaction, and ETH still matches exactly', async () => {
      const { wallet } = await seedUserWithWallet();
      const w = wallet.address;
      ethTransfer(w, { block: 900, from: addr(), to: w, wei: 10n ** 16n });
      const failed = sentTx(w, { block: 920, status: 'failed', gasUsed: 80_000n, l1Fee: 1_234n });

      await sync(wallet.id);
      const rows = await sql<{ source_key: string }>(
        `SELECT source_key FROM normalized_events WHERE wallet_id = $1 AND hash = $2`, [wallet.id, failed.hash],
      );
      expect(rows).toEqual([{ source_key: 'gas' }]);

      const outcomes = await reconcile(wallet.id);
      expect(outcomes.find((o) => o.asset === 'ETH')?.status).toBe('ok');
    });
  });

  describe('token log cross-check', () => {
    it('stores a USDC transfer the feed missed and counts it', async () => {
      const { wallet } = await seedUserWithWallet();
      const w = wallet.address;
      const missed = usdcTransfer(w, { block: 930, from: addr(), to: w, raw: 5_000_000n, inFeed: false });

      await sync(wallet.id);
      const ev = await sql<{ supported: boolean; raw_amount: string }>(
        `SELECT supported, raw_amount::text FROM normalized_events WHERE hash = $1`, [missed],
      );
      expect(ev).toEqual([{ supported: true, raw_amount: '5000000' }]);
      const run = await sql<{ log_gaps: number }>(
        `SELECT log_gaps FROM sync_runs WHERE wallet_id = $1 AND provider = 'alchemy'`, [wallet.id],
      );
      expect(run[0].log_gaps).toBe(1);
      expect((await reconcile(wallet.id)).find((o) => o.asset === 'USDC')?.status).toBe('ok');
    });
  });

  describe('balance check', () => {
    it('finds the exact block of a lost transfer, repairs it and marks the books complete', async () => {
      const { wallet } = await seedUserWithWallet();
      const w = wallet.address;
      usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 10_000_000n });
      const lost = usdcTransfer(w, { block: 950, from: addr(), to: w, raw: 3_000_000n });
      await sync(wallet.id);

      await sql(`DELETE FROM normalized_events WHERE hash = $1`, [lost]);
      await sql(`DELETE FROM raw_transfers WHERE tx_hash = $1`, [lost]);

      const outcomes = await reconcile(wallet.id);
      expect(outcomes.find((o) => o.asset === 'USDC')?.status).toBe('repaired');
      expect(await sql(`SELECT 1 FROM raw_transfers WHERE tx_hash = $1`, [lost])).toHaveLength(1);
      expect(await sql(`SELECT 1 FROM normalized_events WHERE hash = $1`, [lost])).toHaveLength(1);
      const run = await sql<{ details: { repaired_blocks: number[] } }>(
        `SELECT details FROM reconciliation_runs WHERE wallet_id = $1 AND status = 'repaired'`, [wallet.id],
      );
      expect(run[0].details.repaired_blocks).toEqual([950]);
      expect((await jobRow(wallet.id)).ledger_status).toBe('complete');
    });

    it('flags an unexplained change once, keeps what is proven, and reports it to the agent', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const w = wallet.address;
      usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 10_000_000n });
      // ETH that arrived without any source reporting it (e.g. a bridge deposit)
      ethTransfer(w, { block: 960, from: addr(), to: w, wei: 5n * 10n ** 15n, inFeed: false });
      await sync(wallet.id);

      const first = await reconcile(wallet.id);
      expect(first.find((o) => o.asset === 'ETH')).toMatchObject({ status: 'drift', driftBlock: 960 });
      expect(first.find((o) => o.asset === 'USDC')?.status).toBe('ok');
      expect(await jobRow(wallet.id)).toMatchObject({ ledger_status: 'incomplete', incomplete_since_block: '960' });

      await reconcile(wallet.id);
      const alerts = await sql<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM alerts WHERE user_id = $1 AND type = 'ledger_incomplete'`, [user.id],
      );
      expect(alerts[0].n).toBe(1);

      const eth = await sql<{ block_number: string }>(
        `SELECT block_number::text FROM ledger_checkpoints WHERE wallet_id = $1 AND asset = 'ETH'`, [wallet.id],
      );
      expect(eth[0].block_number).toBe('959');

      const status = await getLedgerStatus(user.id);
      expect(status.status).toBe('incomplete');
      expect(status.wallets[0]).toMatchObject({ status: 'incomplete', incomplete_since_block: '960' });
    });

    it('ignores spam tokens entirely', async () => {
      const { wallet } = await seedUserWithWallet();
      const w = wallet.address;
      usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 1_000_000n });
      spamTransfer(w, { block: 940, from: addr(), raw: 999_999_999n });
      await sync(wallet.id);

      const raw = await sql<{ token_address: string }>(
        `SELECT token_address FROM raw_transfers WHERE wallet_id = $1 ORDER BY block_number`, [wallet.id],
      );
      expect(raw.map((r) => r.token_address)).toEqual([USDC, '0x1111111111111111111111111111111111111111']);
      expect((await reconcile(wallet.id)).map((o) => o.status)).toEqual(['ok', 'ok', 'ok']);
    });
  });

  describe('provider fallback', () => {
    it('marks a Blockscout-covered range degraded and re-reads it with Alchemy', async () => {
      const { wallet } = await seedUserWithWallet();
      const w = wallet.address;
      usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 2_000_000n });
      const internal = ethTransfer(w, { block: 930, from: addr(), to: w, wei: 10n ** 15n, category: 'internal' });

      chain.feedDown = true;
      await sync(wallet.id);
      const first = await sql<{ id: string; degraded: boolean; provider: string }>(
        `SELECT id, degraded, provider FROM sync_runs WHERE wallet_id = $1`, [wallet.id],
      );
      expect(first).toMatchObject([{ degraded: true, provider: 'blockscout' }]);
      expect(await sql(`SELECT 1 FROM normalized_events WHERE hash = $1`, [internal])).toHaveLength(0);

      chain.feedDown = false;
      chain.tip = 1100;
      await sync(wallet.id);
      expect(await sql(`SELECT 1 FROM normalized_events WHERE hash = $1`, [internal])).toHaveLength(1);
      const rescanned = await sql<{ rescanned_at: Date | null }>(
        `SELECT rescanned_at FROM sync_runs WHERE id = $1`, [first[0].id],
      );
      expect(rescanned[0].rescanned_at).not.toBeNull();

      expect((await reconcile(wallet.id)).map((o) => o.status)).toEqual(['ok', 'ok', 'ok']);
    });
  });
});
