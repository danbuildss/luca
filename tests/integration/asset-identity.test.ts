// Integration: contract-based asset identity, safe sync cursor, supported-only reads,
// counterparty questions and migration 014's backfill, against real Postgres.
// Chain and price providers are stubbed. See tests/integration/helpers/db.ts for how to run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, vi, beforeEach, describe } from 'vitest';
import type { AlchemyTransfer } from '../../src/ingestion/alchemy.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FAKE = '0x1111111111111111111111111111111111111111';

const chain = vi.hoisted(() => ({ tip: 1000, transfers: [] as AlchemyTransfer[] }));

vi.mock('../../src/ingestion/alchemy.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ingestion/alchemy.js')>();
  return {
    ...orig,
    getCurrentBlock: vi.fn(() => Promise.resolve(chain.tip)),
    // Mimics Alchemy: only transfers inside the requested block range, per direction
    fetchAllTransfers: vi.fn((_key: string, wallet: string, fromHex: string, toHex: string) => {
      const from = parseInt(fromHex, 16);
      const to = parseInt(toHex, 16);
      const w = wallet.toLowerCase();
      return Promise.resolve(chain.transfers.filter((t) => {
        const b = parseInt(t.blockNum, 16);
        return b >= from && b <= to && (t.from.toLowerCase() === w || (t.to ?? '').toLowerCase() === w);
      }));
    }),
    getEthBalance: vi.fn(() => Promise.resolve(1)),
    getErc20Balance: vi.fn(() => Promise.resolve(0)),
  };
});

vi.mock('../../src/ingestion/price.js', () => ({
  enrichUsdValue: vi.fn((identity: { tokenAddress: string | null }, amount: number | null) =>
    Promise.resolve(identity.tokenAddress === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      ? { usd_value: amount, price_source: 'stable', price_at: new Date() }
      : { usd_value: null, price_source: null, price_at: null })),
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassification,
  insertClassifiedEvent, sql, addr,
} from './helpers/db.js';
import { syncWallet, getActiveWatchJobs, OVERLAP_BLOCKS } from '../../src/ingestion/ingest.js';
import { getPnlSummary } from '../../src/books/query.js';
import { getEventsForReview } from '../../src/corrections/store.js';
import { detectUnknownCounterparties } from '../../src/alerts/counterparty.js';

let seq = 0;
function transfer(wallet: string, overrides: Partial<AlchemyTransfer> & { block: number }): AlchemyTransfer {
  seq++;
  const hash = `0x${seq.toString(16).padStart(64, 'a')}`;
  const { block, ...rest } = overrides;
  return {
    blockNum: `0x${block.toString(16)}`,
    uniqueId: `${hash}:log:1`,
    hash,
    from: addr(),
    to: wallet,
    value: 100,
    asset: 'USDC',
    category: 'erc20',
    metadata: { blockTimestamp: '2026-09-23T10:00:00Z' },
    rawContract: { value: '0x5f5e100', address: USDC, decimal: '0x6' },
    ...rest,
  };
}

async function jobFor(walletId: string) {
  const jobs = await getActiveWatchJobs();
  return jobs.find((j) => j.wallet_id === walletId)!;
}

async function events(walletId: string) {
  return sql<{ hash: string; asset: string; token_address: string | null; supported: boolean | null }>(
    `SELECT hash, asset, token_address, supported FROM normalized_events WHERE wallet_id = $1 ORDER BY block_time, hash`,
    [walletId],
  );
}

async function cursor(walletId: string): Promise<string | null> {
  const rows = await sql<{ last_block: string | null }>(`SELECT last_block::text FROM watch_jobs WHERE wallet_id = $1`, [walletId]);
  return rows[0].last_block;
}

describeDb('asset identity and sync (integration)', () => {
  useIntegrationDb();

  beforeEach(() => {
    chain.tip = 1000;
    chain.transfers = [];
  });

  describe('syncWallet', () => {
    it('stores fake USDC and fake ETH as unsupported and real assets as supported', async () => {
      const { wallet } = await seedUserWithWallet();
      chain.transfers = [
        transfer(wallet.address, { block: 900 }),
        transfer(wallet.address, { block: 901, rawContract: { value: '0x1', address: FAKE, decimal: '0x6' } }),
        transfer(wallet.address, { block: 902, asset: 'ETH', rawContract: { value: '0x1', address: FAKE, decimal: '0x12' } }),
        transfer(wallet.address, {
          block: 903, category: 'external', asset: 'ETH', value: 0.2,
          rawContract: { value: '0x1', address: null, decimal: null },
        }),
      ];
      chain.transfers[3].uniqueId = `${chain.transfers[3].hash}:external`;

      await syncWallet(await jobFor(wallet.id), 'key');

      const rows = await events(wallet.id);
      expect(rows.map((r) => [r.asset, r.supported])).toEqual([
        ['USDC', true], ['USDC', false], ['ETH', false], ['ETH', true],
      ]);
      expect(rows[1].token_address).toBe(FAKE);
      expect(await cursor(wallet.id)).toBe('990');
    });

    it('stops 10 blocks short of the tip and catches late-indexed transfers in the overlap', async () => {
      const { wallet } = await seedUserWithWallet();
      const tipTransfer = transfer(wallet.address, { block: 995 });
      chain.transfers = [transfer(wallet.address, { block: 900 }), tipTransfer];
      await syncWallet(await jobFor(wallet.id), 'key');
      expect((await events(wallet.id)).map((r) => r.hash)).not.toContain(tipTransfer.hash);

      // A transfer Alchemy had not indexed during the first sync, behind the cursor
      const late = transfer(wallet.address, { block: 990 - OVERLAP_BLOCKS + 50 });
      chain.transfers.push(late);
      chain.tip = 1100;
      await syncWallet(await jobFor(wallet.id), 'key');

      const hashes = (await events(wallet.id)).map((r) => r.hash);
      expect(hashes).toContain(tipTransfer.hash);
      expect(hashes).toContain(late.hash);
      expect(hashes).toHaveLength(3);
      expect(await cursor(wallet.id)).toBe('1090');
    });

    it('keeps the cursor in place and records a partial run when a transfer fails to store', async () => {
      const { wallet } = await seedUserWithWallet();
      chain.transfers = [transfer(wallet.address, { block: 900 })];
      await syncWallet(await jobFor(wallet.id), 'key');
      expect(await cursor(wallet.id)).toBe('990');

      chain.tip = 1100;
      chain.transfers.push(
        transfer(wallet.address, { block: 1000 }),
        transfer(wallet.address, { block: 1001, metadata: { blockTimestamp: 'not-a-date' } }),
      );
      await syncWallet(await jobFor(wallet.id), 'key');

      expect(await cursor(wallet.id)).toBe('990');
      const runs = await sql<{ status: string; failed_count: number; events_ingested: number }>(
        `SELECT status, failed_count, events_ingested FROM sync_runs WHERE wallet_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [wallet.id],
      );
      expect(runs[0]).toEqual({ status: 'partial', failed_count: 1, events_ingested: 2 });
      expect(await events(wallet.id)).toHaveLength(2);
    });

    it('fills in identity for rows stored before migration 014 and retires labels on spam', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const real = transfer(wallet.address, { block: 900 });
      const spam = transfer(wallet.address, { block: 901, rawContract: { value: '0x1', address: FAKE, decimal: '0x6' } });
      chain.transfers = [real, spam];

      const oldReal = await insertEvent({
        wallet, direction: 'in', hash: real.hash, sourceKey: 'log:1', logIndex: 1,
        counterparty: real.from, supported: null, tokenAddress: null,
      });
      const oldSpam = await insertEvent({
        wallet, direction: 'in', hash: spam.hash, sourceKey: 'log:1', logIndex: 1,
        counterparty: spam.from, supported: null, tokenAddress: null, usdValue: 100,
      });
      await insertClassification({ eventId: oldSpam.id, userId: user.id, label: 'revenue', confidence: 0.9 });

      await syncWallet(await jobFor(wallet.id), 'key');

      const rows = await sql<{ id: string; token_address: string | null; supported: boolean }>(
        `SELECT id, token_address, supported FROM normalized_events WHERE wallet_id = $1`, [wallet.id],
      );
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === oldReal.id)).toMatchObject({ token_address: USDC, supported: true });
      expect(rows.find((r) => r.id === oldSpam.id)).toMatchObject({ token_address: FAKE, supported: false });

      const active = await sql(`SELECT 1 FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [oldSpam.id]);
      expect(active).toHaveLength(0);
      expect((await getPnlSummary(user.id, 30)).revenue_usdc).toBe(0);
    });
  });

  describe('supported-only reads', () => {
    it('books ignore a fake USDC token and report unclassified transfers as pending', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertClassifiedEvent({
        wallet, direction: 'in', label: 'revenue', amount: 5000, usdValue: 5000,
        tokenAddress: FAKE, supported: false,
      });
      await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', amount: 40 }); // real USDC, no stored USD
      await insertEvent({ wallet, direction: 'in', amount: 7 }); // not classified yet

      const pnl = await getPnlSummary(user.id, 30);
      expect(pnl.revenue_usdc).toBe(40);
      expect(pnl.pending_count).toBe(1);
    });

    it('review lists never show unsupported or unverified transfers', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertEvent({ wallet, direction: 'in', asset: 'SCAM' });
      await insertEvent({ wallet, direction: 'in', supported: null, tokenAddress: null });
      const real = await insertEvent({ wallet, direction: 'in' });
      const list = await getEventsForReview({ userId: user.id });
      expect(list.map((e) => e.id)).toEqual([real.id]);
    });
  });

  describe('counterparty questions', () => {
    it('asks about an unpriced ETH transfer', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertClassifiedEvent({ wallet, direction: 'in', asset: 'ETH', amount: 0.5, label: 'unknown' });
      expect(await detectUnknownCounterparties(user.id)).toHaveLength(1);
    });

    it('never asks about spam tokens, whatever their stated value', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertClassifiedEvent({ wallet, direction: 'in', asset: 'USDC', tokenAddress: FAKE, supported: false, amount: 9999, usdValue: 9999, label: 'unknown' });
      expect(await detectUnknownCounterparties(user.id)).toHaveLength(0);
    });

    it('asks again about a skipped counterparty only for transfers that arrive after the skip', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const cp = addr();
      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 50, label: 'unknown' });
      await sql(
        `INSERT INTO pending_counterparty_alerts (user_id, counterparty_address, watched_wallet_address, status, resolved_at, telegram_message_id)
         VALUES ($1, $2, $3, 'skipped', NOW() + INTERVAL '1 minute', 42)`,
        [user.id, cp, wallet.address],
      );
      expect(await detectUnknownCounterparties(user.id)).toHaveLength(0);

      await sql(`UPDATE pending_counterparty_alerts SET resolved_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`, [user.id]);
      expect(await detectUnknownCounterparties(user.id)).toHaveLength(1);
      const [row] = await sql<{ status: string; telegram_message_id: string | null }>(
        `SELECT status, telegram_message_id FROM pending_counterparty_alerts WHERE user_id = $1`, [user.id],
      );
      expect(row).toEqual({ status: 'pending', telegram_message_id: null });
    });
  });

  describe('migration 014 backfill', () => {
    const migration = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations/014_asset_identity.sql'),
      'utf8',
    );

    it('marks what stored data proves, retires spam labels, clears stale BNKR prices and rewinds cursors', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const eth = await insertEvent({ wallet, direction: 'in', asset: 'ETH', sourceKey: 'external', supported: null });
      const usdc = await insertEvent({ wallet, direction: 'in', sourceKey: 'log:3', logIndex: 3, supported: null, tokenAddress: null });
      const spam = await insertEvent({ wallet, direction: 'in', sourceKey: 'log:5', logIndex: 5, supported: null, tokenAddress: null });
      const unproven = await insertEvent({ wallet, direction: 'in', sourceKey: 'log:7', logIndex: 7, supported: null, tokenAddress: null });
      const bnkr = await insertEvent({ wallet, direction: 'in', asset: 'BNKR', amount: 1000, usdValue: 2, at: '3 days' });
      await sql(`UPDATE normalized_events SET price_source = 'coingecko' WHERE id = $1`, [bnkr.id]);
      await insertClassification({ eventId: spam.id, userId: user.id, label: 'revenue', confidence: 0.9 });

      const payload = (hash: string, log: number, contract: string) =>
        JSON.stringify({ uniqueId: `${hash}:log:${log}`, rawContract: { address: contract } });
      await sql(`UPDATE transactions SET raw_payload = $2::jsonb, block_number = 5000 WHERE id = $1`,
        [usdc.transactionId, payload(usdc.hash, 3, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')]);
      await sql(`UPDATE transactions SET raw_payload = $2::jsonb, block_number = 4000 WHERE id = $1`,
        [spam.transactionId, payload(spam.hash, 5, FAKE)]);
      await sql(`UPDATE transactions SET raw_payload = $2::jsonb WHERE id = $1`,
        [unproven.transactionId, payload(unproven.hash, 9, USDC)]);
      await sql(`UPDATE watch_jobs SET last_block = 999999 WHERE wallet_id = $1`, [wallet.id]);

      await sql(migration);

      const byId = new Map((await sql<{ id: string; supported: boolean | null; token_address: string | null; asset: string; usd_value: string | null; price_source: string | null }>(
        `SELECT id, supported, token_address, asset, usd_value::text, price_source FROM normalized_events WHERE wallet_id = $1`, [wallet.id],
      )).map((r) => [r.id, r]));
      expect(byId.get(eth.id)).toMatchObject({ supported: true, token_address: null });
      expect(byId.get(usdc.id)).toMatchObject({ supported: true, token_address: USDC, asset: 'USDC' });
      expect(byId.get(spam.id)).toMatchObject({ supported: false, token_address: FAKE });
      expect(byId.get(unproven.id)).toMatchObject({ supported: null });
      expect(byId.get(bnkr.id)).toMatchObject({ usd_value: null, price_source: 'unavailable' });

      expect(await sql(`SELECT 1 FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [spam.id])).toHaveLength(0);
      expect(await cursor(wallet.id)).toBe('3999');

      await sql(`INSERT INTO sync_runs (wallet_id, provider, chain, status) VALUES ($1, 'alchemy', 'base', 'partial')`, [wallet.id]);
    });
  });
});
