// Integration: the Phase 1 gate. One transaction is followed through every layer
// (src/ledger/trace.ts) and a wallet's whole history is audited (src/ledger/audit.ts),
// against real Postgres and a simulated chain. Also the ingestion edge cases the roadmap
// lists: several transfers in one transaction, idempotent re-reads, failed transactions.
import { it, expect, vi, beforeEach, describe } from 'vitest';

vi.mock('../../src/ingestion/alchemy.js', async (importOriginal) =>
  (await import('./helpers/chain.js')).alchemyMock(await importOriginal<Record<string, unknown>>()));
vi.mock('../../src/ingestion/blockscout.js', async (importOriginal) =>
  (await import('./helpers/chain.js')).blockscoutMock(await importOriginal<Record<string, unknown>>()));
vi.mock('axios', async () => {
  const { blockscoutHttp } = await import('./helpers/chain.js');
  return { default: { get: blockscoutHttp, post: () => Promise.reject(new Error('unexpected axios.post')) } };
});
vi.mock('../../src/ingestion/price.js', () => ({
  enrichUsdValue: vi.fn(() => Promise.resolve({ usd_value: null, price_source: null, price_at: null })),
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
}));

import { describeDb, useIntegrationDb, seedUserWithWallet, insertClassification, sql, addr } from './helpers/db.js';
import { chain, resetChain, usdcTransfer, ethTransfer, sentTx } from './helpers/chain.js';
import { syncWallet, getActiveWatchJobs } from '../../src/ingestion/ingest.js';
import { traceTransaction, describeTrace } from '../../src/ledger/trace.js';
import { auditWallet, describeAudit } from '../../src/ledger/audit.js';

async function sync(walletId: string): Promise<void> {
  const job = (await getActiveWatchJobs()).find((j) => j.wallet_id === walletId)!;
  await syncWallet(job, 'key');
}

// Label every stored, supported event of a transaction (a rule, so it is confirmed)
async function label(userId: string, hash: string, l: 'revenue' | 'expense' | 'gas' = 'revenue'): Promise<void> {
  const rows = await sql<{ id: string; source_key: string }>(
    `SELECT id, source_key FROM normalized_events WHERE LOWER(hash) = LOWER($1) AND supported IS TRUE`, [hash],
  );
  for (const r of rows) {
    await insertClassification({ eventId: r.id, userId, label: r.source_key === 'gas' ? 'gas' : l, method: 'counterparty' });
  }
}

describeDb('transaction trace and wallet audit (integration)', () => {
  useIntegrationDb();
  beforeEach(() => resetChain());

  describe('traceTransaction', () => {
    it('follows a received USDC payment from the chain into the books', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const h = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 25_000_000n });
      await sync(wallet.id);
      await label(user.id, h);

      const t = await traceTransaction(h, 'key');
      expect(t.verdict).toBe('complete');
      expect(t.status).toBe('success');
      expect(t.movements).toHaveLength(1);
      expect(t.movements[0]).toMatchObject({
        source_key: 'log:1', asset: 'USDC', direction: 'in', chain: true, provider: true, raw: true,
        normalized: true, supported: true, label: 'revenue', label_status: 'confirmed',
        books: { figure: 'revenue', usd: 25 }, lost_at: null,
      });
    });

    it('names the transfer feed when it missed a payment Luca never stored', async () => {
      const { wallet } = await seedUserWithWallet();
      // Not synced yet, and the transfer feed does not report it
      const h = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 5_000_000n, inFeed: false });
      const t = await traceTransaction(h, 'key');
      expect(t.verdict).toBe('gaps');
      expect(t.movements[0]).toMatchObject({ chain: true, provider: false, raw: false, lost_at: 'provider' });
    });

    it('a payment the feed missed but the log cross-check caught is complete, with a note', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const h = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 5_000_000n, inFeed: false });
      await sync(wallet.id);
      await label(user.id, h);
      const t = await traceTransaction(h, 'key');
      expect(t.verdict).toBe('complete');
      expect(t.movements[0].provider_name).toBe('logs');
      expect(t.movements[0].notes).toContain('missed by the transfer feed, caught by the token-log cross-check');
    });

    it('stops at classification when a stored transfer has no label yet', async () => {
      const { wallet } = await seedUserWithWallet();
      const h = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 1_000_000n });
      await sync(wallet.id);
      const t = await traceTransaction(h, 'key');
      expect(t.movements[0].lost_at).toBe('classification');
    });

    it('stops at identity when a real USDC transfer was stored as unsupported', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const h = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 1_000_000n });
      await sync(wallet.id);
      await label(user.id, h);
      await sql(`UPDATE normalized_events SET supported = FALSE WHERE hash = $1`, [h]);
      expect((await traceTransaction(h, 'key')).movements[0].lost_at).toBe('identity');
    });

    it('stops at price when ETH revenue has no USD value', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const h = ethTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, wei: 10n ** 16n });
      await sync(wallet.id);
      await label(user.id, h);
      const m = (await traceTransaction(h, 'key')).movements[0];
      expect(m).toMatchObject({ source_key: 'external', asset: 'ETH', lost_at: 'price' });
    });

    it('traces the fee of a sent transaction and every leg of a multi-transfer transaction', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const w = wallet.address;
      const { hash } = sentTx(w, { block: 910 });
      // One transaction: two USDC transfers out, ETH received back from the contract
      usdcTransfer(w, { block: 910, from: w, to: addr(), raw: 1_000_000n, txHash: hash, logIndex: 4 });
      usdcTransfer(w, { block: 910, from: w, to: addr(), raw: 2_000_000n, txHash: hash, logIndex: 7 });
      ethTransfer(w, { block: 910, from: addr(), to: w, wei: 10n ** 15n, category: 'internal', txHash: hash });
      await sync(wallet.id);
      await label(user.id, hash, 'expense');

      const t = await traceTransaction(hash, 'key');
      const keys = t.movements.map((m) => m.source_key).sort();
      expect(keys).toEqual(['gas', 'internal:0', 'log:4', 'log:7']);
      // Contract-sent ETH is only visible through the transfer feed
      expect(t.movements.find((m) => m.source_key === 'internal:0')).toMatchObject({ chain: null, provider: true, raw: true });
      expect(t.movements.find((m) => m.source_key === 'gas')).toMatchObject({ chain: true, raw: true, books: { figure: 'gas' } });
      expect(t.movements.filter((m) => m.source_key.startsWith('log:')).every((m) => m.books?.figure === 'expenses')).toBe(true);
    });

    it('reports a transfer recorded for a failed transaction', async () => {
      const { wallet } = await seedUserWithWallet();
      const { hash } = sentTx(wallet.address, { block: 920, status: 'failed' });
      await sync(wallet.id);
      // A stored ETH payment for the failed transaction, as an older sync could have left it
      const tx = await sql<{ id: string }>(`SELECT id FROM transactions WHERE hash = $1`, [hash]);
      await sql(
        `INSERT INTO normalized_events (transaction_id, wallet_id, user_id, chain, hash, source_key, block_time,
           from_address, to_address, asset, amount, direction, supported, block_number)
         VALUES ($1, $2, $3, 'base', $4, 'external', NOW(), $5, $6, 'ETH', 0.5, 'out', TRUE, 920)`,
        [tx[0].id, wallet.id, wallet.userId, hash, wallet.address, addr()],
      );
      const t = await traceTransaction(hash, 'key');
      expect(t.status).toBe('failed');
      expect(t.movements.find((m) => m.source_key === 'external')).toMatchObject({
        chain: false, lost_at: 'chain', notes: ['recorded as a transfer, but the transaction failed and moved nothing'],
      });
      expect(describeTrace(t)[1]).toBe('The transaction failed on chain, so only its fee moved.');
    });

    it('tells apart an unknown hash and one that touches none of Luca\'s wallets', async () => {
      await seedUserWithWallet();
      expect((await traceTransaction(`0x${'ab'.repeat(32)}`, 'key')).verdict).toBe('not_found');
      const h = usdcTransfer(addr(), { block: 900, from: addr(), to: addr(), raw: 1n });
      expect((await traceTransaction(h, 'key')).verdict).toBe('not_tracked');
    });

    it('counts the answers that quoted the transaction', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const h = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 1_000_000n });
      await sync(wallet.id);
      await sql(`INSERT INTO answer_traces (user_id, question, answer) VALUES ($1, 'q', $2)`,
        [user.id, `- Sep 16  1 USDC  [${h.slice(0, 6)}…${h.slice(-4)}](https://basescan.org/tx/${h})`]);
      expect((await traceTransaction(h, 'key')).answers).toBe(1);
    });

    it('without an Alchemy key it checks only what Luca stored', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const h = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 1_000_000n });
      await sync(wallet.id);
      await label(user.id, h);
      const t = await traceTransaction(h);
      expect(t).toMatchObject({ checked_chain: false, verdict: 'complete' });
      expect(t.movements[0]).toMatchObject({ chain: null, provider: null, raw: true });
    });
  });

  describe('ingestion edge cases', () => {
    it('re-reading the same range stores nothing twice', async () => {
      const { wallet } = await seedUserWithWallet();
      const w = wallet.address;
      usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 1_000_000n });
      ethTransfer(w, { block: 900, from: addr(), to: w, wei: 10n ** 15n });
      sentTx(w, { block: 950 });
      await sync(wallet.id);
      const count = async () => (await sql<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM normalized_events WHERE wallet_id = $1)::int
              + (SELECT COUNT(*) FROM raw_transfers WHERE wallet_id = $1)::int AS n`, [wallet.id]))[0].n;
      const before = await count();
      // Rewind the cursor so the whole range is read again, and read it a third time
      await sql(`UPDATE watch_jobs SET last_block = 800 WHERE wallet_id = $1`, [wallet.id]);
      await sync(wallet.id);
      await sql(`UPDATE watch_jobs SET last_block = 800 WHERE wallet_id = $1`, [wallet.id]);
      await sync(wallet.id);
      expect(await count()).toBe(before);
    });

    it('two transactions in the same block are both stored', async () => {
      const { wallet } = await seedUserWithWallet();
      const w = wallet.address;
      const a = usdcTransfer(w, { block: 950, from: addr(), to: w, raw: 1_000_000n });
      const b = usdcTransfer(w, { block: 950, from: addr(), to: w, raw: 2_000_000n });
      await sync(wallet.id);
      const rows = await sql<{ hash: string }>(`SELECT hash FROM normalized_events WHERE wallet_id = $1 ORDER BY hash`, [wallet.id]);
      expect(rows.map((r) => r.hash)).toEqual([a, b].sort());
    });

    it('a transfer reported inside a failed transaction is kept as evidence, not in the books', async () => {
      const { wallet } = await seedUserWithWallet();
      const w = wallet.address;
      const { hash } = sentTx(w, { block: 920, status: 'failed' });
      // The feed wrongly reports the ETH the failed transaction tried to send
      chain.feed.push({
        blockNum: '0x398', uniqueId: `${hash}:external`, hash, from: w, to: addr(), value: 0.5, asset: 'ETH',
        category: 'external', metadata: { blockTimestamp: new Date().toISOString() },
        rawContract: { value: '0x6f05b59d3b20000', address: null, decimal: '0x12' },
      });
      await sync(wallet.id);
      const rows = await sql<{ source_key: string; supported: boolean }>(
        `SELECT source_key, supported FROM normalized_events WHERE hash = $1 ORDER BY source_key`, [hash]);
      expect(rows).toEqual([{ source_key: 'external', supported: false }, { source_key: 'gas', supported: true }]);
    });
  });

  describe('auditWallet', () => {
    it('finds every transaction any source knows and counts what was lost where', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const w = wallet.address;
      const ok = usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 1_000_000n });
      const unlabeled = usdcTransfer(w, { block: 905, from: addr(), to: w, raw: 2_000_000n });
      await sync(wallet.id);
      await label(user.id, ok);
      // Arrives after the last sync and the feed misses it: only the token logs know it
      const missed = usdcTransfer(w, { block: 950, from: addr(), to: w, raw: 3_000_000n, inFeed: false });

      const a = await auditWallet(w, 'key');
      expect(a.transactions).toBe(3);
      expect(a.verdicts).toMatchObject({ complete: 1, gaps: 2 });
      expect(a.lost.map((l) => [l.hash, l.layer]).sort()).toEqual([[missed, 'provider'], [unlabeled, 'classification']].sort());
      expect(describeAudit(a).join('\n')).toContain('provider: 1');
    });

    it('refuses a wallet Luca does not track', async () => {
      await expect(auditWallet(addr(), 'key')).rejects.toThrow('is not a wallet Luca tracks');
    });
  });
});
