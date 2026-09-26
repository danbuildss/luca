// Integration: "are my books complete?" from chat (src/ledger/audit-runs.ts). Background
// checks recorded in audit_runs, reuse while the books are unchanged, restart recovery,
// operator scoping, and the exact wording Luca sends. Real Postgres, simulated chain.
import fs from 'node:fs';
import { it, expect, vi, beforeEach, describe } from 'vitest';

vi.mock('../../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<{ config: Record<string, unknown> }>();
  return { ...orig, config: { ...orig.config, ALCHEMY_API_KEY: 'key' } };
});
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

import { describeDb, useIntegrationDb, seedUserWithWallet, insertUser, insertClassification, sql, addr } from './helpers/db.js';
import { chain, resetChain, usdcTransfer, ethTransfer, sentTx } from './helpers/chain.js';
import { syncWallet, getActiveWatchJobs } from '../../src/ingestion/ingest.js';
import { recoverAudits, setAuditNotifier } from '../../src/ledger/audit-runs.js';
import { executeTool } from '../../src/agent/tools.js';
import { executeAdminTool } from '../../src/agent/admin-tools.js';

const sent: Array<{ to: string; text: string }> = [];
setAuditNotifier((to, text) => { sent.push({ to, text }); return Promise.resolve(); });

// Set WORDING_OUT=<file> to write each scenario's exact message to a file
function record(scenario: string, text: string): void {
  if (process.env.WORDING_OUT) fs.appendFileSync(process.env.WORDING_OUT, `### ${scenario}\n${text}\n\n`);
}

async function sync(walletId: string): Promise<void> {
  const job = (await getActiveWatchJobs()).find((j) => j.wallet_id === walletId)!;
  await syncWallet(job, 'key');
}

async function label(userId: string, hash: string, l: 'revenue' | 'unknown' = 'revenue'): Promise<void> {
  const rows = await sql<{ id: string; source_key: string }>(
    `SELECT id, source_key FROM normalized_events WHERE hash = $1 AND supported IS TRUE`, [hash]);
  for (const r of rows) {
    await insertClassification({
      eventId: r.id, userId, label: r.source_key === 'gas' ? 'gas' : l,
      method: l === 'unknown' ? 'deterministic' : 'counterparty', confidence: l === 'unknown' ? 0 : 0.95,
    });
  }
}

// Wait for the background check to finish and its message to be delivered
async function finished(runs = 1): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const done = await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_runs WHERE delivered_at IS NOT NULL`);
    if (done[0].n >= runs) return sent[sent.length - 1].text;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('check did not finish');
}

describeDb('books check from chat (integration)', () => {
  useIntegrationDb();
  // Tip 1200: the safe block a check verifies up to is 1050 (tip minus 150), above the
  // transfers these tests make at blocks 900–950; the sync reaches 1190.
  beforeEach(() => { resetChain(); chain.tip = 1200; sent.length = 0; });

  it('everything complete: states the range, wallets and counts, and that every movement reached the books', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
    const w = wallet.address;
    const a = usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 25_000_000n });
    const b = sentTx(w, { block: 920 }).hash;
    await sync(wallet.id);
    await label(user.id, a);
    await label(user.id, b);
    // Prices are stubbed out in this file; give the fee its USD value
    await sql(`UPDATE normalized_events SET usd_value = 0.01 WHERE source_key = 'gas'`);

    const r = await executeTool(user.id, 'check_books_complete', {});
    expect(r).toMatchObject({ status: 'started', wallets: 1 });
    const text = await finished();
    record('Everything complete', text);
    expect(text).toMatch(/^I checked everything I've tracked across your wallet on \w{3} \d+, up to \d\d:\d\d: 2 transactions, 2 supported financial movements\.\nEvery supported movement reached your books\.$/);
    expect(text).not.toMatch(/\ball\b/);
    const run = await sql<{ status: string; result: { wallets: Array<{ to_block: number; synced_to: number; signature: string }>; transactions: number } }>(`SELECT status, result FROM audit_runs`);
    expect(run[0]).toMatchObject({ status: 'complete', result: { transactions: 2 } });
    // Verified up to the safe chain block, not Luca's own sync checkpoint
    expect(run[0].result.wallets[0]).toMatchObject({ to_block: 1050, synced_to: 1190 });
    expect(run[0].result.wallets[0].signature).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{32}$/);
  });

  it('one transaction genuinely missing: says which, and that it never arrived from the provider', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
    const w = wallet.address;
    const a = usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 25_000_000n });
    await sync(wallet.id);
    await label(user.id, a);
    // In the synced range, but neither source reported it when Luca synced
    const missed = usdcTransfer(w, { block: 950, from: addr(), to: w, raw: 12_000_000n, inFeed: false });

    await executeTool(user.id, 'check_books_complete', {});
    const text = await finished();
    record('One transaction genuinely missing', text);
    expect(text).toContain('2 transactions, 2 supported financial movements');
    expect(text).toContain('1 movement is missing from your books:');
    expect(text).toContain(`12.00 USDC in (${missed.slice(0, 6)}…${missed.slice(-4)}): my data provider never delivered it, so it's missing from your books.`);
    expect(text).toContain("I haven't changed anything in your books.");
    expect(text).not.toContain('Every supported movement reached');
  });

  it('everything present, one still unknown: complete, and the unknown is not called missing', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
    const w = wallet.address;
    const a = usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 25_000_000n });
    const u = usdcTransfer(w, { block: 910, from: addr(), to: w, raw: 410_000_000n });
    await sync(wallet.id);
    await label(user.id, a);
    await label(user.id, u, 'unknown');

    await executeTool(user.id, 'check_books_complete', {});
    const text = await finished();
    record('Everything present, one still unknown', text);
    expect(text).toContain('Every supported movement reached your books.');
    expect(text).toContain("1 movement is still labeled unknown, waiting for you to say what it was. It's in your books, not missing.");
    expect(text).not.toContain('missing from your books');
  });

  it('provider unavailable: says the check could not finish and that nothing changed', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
    usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 1_000_000n });
    await sync(wallet.id);
    chain.feedDown = true;

    await executeTool(user.id, 'check_books_complete', {});
    const text = await finished();
    record('Check could not complete: provider unavailable', text);
    expect(text).toBe("I couldn't finish checking your wallets: my blockchain data provider isn't responding right now. Nothing in the books has changed. Ask me again in a few minutes and I'll run the check again.");
    expect((await sql<{ status: string }>(`SELECT status FROM audit_runs`))[0].status).toBe('failed');
  });

  describe('reusing a result', () => {
    async function completeCheck() {
      const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
      const w = wallet.address;
      const a = usdcTransfer(w, { block: 900, from: addr(), to: w, raw: 1_000_000n });
      await sync(wallet.id);
      await label(user.id, a);
      await executeTool(user.id, 'check_books_complete', {});
      const text = await finished();
      expect(text).toContain('Every supported movement reached your books.');
      return { user, wallet, w };
    }
    const runs = async () => (await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_runs`))[0].n;

    it('reuses the result only when the chain has no new safe blocks and the books are unchanged', async () => {
      const { user } = await completeCheck();
      const again = await executeTool(user.id, 'check_books_complete', {});
      expect(again).toMatchObject({ status: 'result' });
      expect((again as { result: string }).result).toMatch(/^Nothing has changed in your books since I checked at /);
      expect(await runs()).toBe(1);
    });

    it('a new on-chain transaction the sync has not reached: not reused, verified, reported missing', async () => {
      const { user, w } = await completeCheck();
      // The chain moves on and a payment arrives; Luca's sync does not run, so the
      // database is exactly as it was
      chain.tip = 1400;
      const late = usdcTransfer(w, { block: 1200, from: addr(), to: w, raw: 7_000_000n });

      const again = await executeTool(user.id, 'check_books_complete', {});
      expect(again).toMatchObject({ status: 'started' });
      const text = await finished(2);
      record('New on-chain transaction not in the database (sync behind)', text);
      expect(text).not.toContain('Every supported movement reached');
      expect(text).toContain('2 transactions, 2 supported financial movements');
      expect(text).toContain(`7.00 USDC in (${late.slice(0, 6)}…${late.slice(-4)}): I haven't synced it yet (my last sync of this wallet reached `);
      // Only the new blocks were checked, on top of the earlier result
      const run = await sql<{ base_run_id: string | null; to_block: number }>(
        `SELECT base_run_id, (result->'wallets'->0->>'to_block')::int AS to_block FROM audit_runs ORDER BY started_at DESC LIMIT 1`);
      expect(run[0].base_run_id).not.toBeNull();
      expect(run[0].to_block).toBe(1250);
    });

    it('a new on-chain transaction the sync passed over and lost: not reused, reported as never delivered', async () => {
      const { user, wallet, w } = await completeCheck();
      chain.tip = 1400;
      // Neither the transfer feed nor the token logs report it when Luca syncs, so the
      // sync moves its cursor past it and stores nothing
      const lost = usdcTransfer(w, { block: 1200, from: addr(), to: w, raw: 9_000_000n, inFeed: false, inLogs: false });
      await sync(wallet.id);
      expect((await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM normalized_events WHERE hash = $1`, [lost]))[0].n).toBe(0);
      // The chain itself has it (its Transfer log is readable now)
      usdcTransfer(w, { block: 1200, from: addr(), to: w, raw: 9_000_000n, inFeed: false, inLogs: true, txHash: lost });

      expect(await executeTool(user.id, 'check_books_complete', {})).toMatchObject({ status: 'started' });
      const text = await finished(2);
      record('New on-chain transaction the sync lost', text);
      expect(text).toContain(`9.00 USDC in (${lost.slice(0, 6)}…${lost.slice(-4)}): my data provider never delivered it, so it's missing from your books.`);
    });

    it('a stored USD value changes (non-null to a different non-null): not reused, checked again in full', async () => {
      const { user, wallet } = await completeCheck();
      // Priced, then checked: the result holds while the value stays 1.00
      await sql(`UPDATE normalized_events SET usd_value = 1.00 WHERE wallet_id = $1`, [wallet.id]);
      await executeTool(user.id, 'check_books_complete', {});
      await finished(2);
      expect(await executeTool(user.id, 'check_books_complete', {})).toMatchObject({ status: 'result' });
      // Repriced: still non-null, different value
      await sql(`UPDATE normalized_events SET usd_value = 1.37 WHERE wallet_id = $1`, [wallet.id]);

      const again = await executeTool(user.id, 'check_books_complete', {});
      expect(again).toMatchObject({ status: 'started' });
      await finished(3);
      const last = await sql<{ base_run_id: string | null }>(`SELECT base_run_id FROM audit_runs ORDER BY started_at DESC LIMIT 1`);
      expect(last[0].base_run_id).toBeNull();
    });

    it('a label change also invalidates the result', async () => {
      const { user, wallet } = await completeCheck();
      await sql(`UPDATE classifications SET superseded_at = NOW() WHERE user_id = $1`, [user.id]);
      const ev = await sql<{ id: string }>(`SELECT id FROM normalized_events WHERE wallet_id = $1`, [wallet.id]);
      await insertClassification({ eventId: ev[0].id, userId: user.id, label: 'expense', method: 'counterparty' });
      expect(await executeTool(user.id, 'check_books_complete', {})).toMatchObject({ status: 'started' });
      await finished(2);
    });
  });

  describe('native ETH discovery', () => {
    it('an inbound ETH payment Alchemy missed is found through Blockscout and reported', async () => {
      const { wallet } = await seedUserWithWallet({ timezone: 'UTC' });
      const w = wallet.address;
      // Alchemy's feed never reports it; token logs cannot (it is ETH) and the sent list
      // cannot (the wallet received it). Only Blockscout's transaction list has it.
      const eth = ethTransfer(w, { block: 900, from: addr(), to: w, wei: 10n ** 16n, inFeed: false });
      await sync(wallet.id);
      expect((await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM normalized_events WHERE hash = $1`, [eth]))[0].n).toBe(0);

      await executeTool(wallet.userId, 'check_books_complete', {});
      const text = await finished();
      record('Inbound ETH missed by Alchemy, found via Blockscout', text);
      expect(text).toContain('1 transaction, 1 supported financial movement');
      expect(text).toContain(`0.01 ETH in (${eth.slice(0, 6)}…${eth.slice(-4)}): my data provider never delivered it, so it's missing from your books.`);
      expect(text).not.toContain('Every supported movement reached');
    });

    it('an inbound ETH payment both sources report is counted once', async () => {
      const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
      const w = wallet.address;
      const eth = ethTransfer(w, { block: 900, from: addr(), to: w, wei: 10n ** 16n });
      await sync(wallet.id);
      await label(user.id, eth);
      await sql(`UPDATE normalized_events SET usd_value = 40 WHERE hash = $1`, [eth]);

      await executeTool(user.id, 'check_books_complete', {});
      const text = await finished();
      expect(text).toContain('1 transaction, 1 supported financial movement.');
      expect(text).toContain('Every supported movement reached your books.');
    });

    it('a failed, zero-value transaction the wallet sent is still found for its fee', async () => {
      const { wallet } = await seedUserWithWallet({ timezone: 'UTC' });
      await sync(wallet.id);
      // After Luca's last sync: nothing stored. It moved no ETH, so neither Alchemy's feed
      // nor Blockscout's native list has it; only the sent list does.
      chain.tip = 1400;
      const { hash } = sentTx(wallet.address, { block: 1200, status: 'failed', gasUsed: 50_000n, gasPrice: 2_000_000n });
      expect(chain.feed.some((t) => t.hash === hash)).toBe(false);
      expect(chain.native.some((t) => t.hash === hash)).toBe(false);

      await executeTool(wallet.userId, 'check_books_complete', {});
      const text = await finished();
      record('Failed zero-value sent transaction found for its fee', text);
      expect(text).toContain(`network fee of 0.0000001 ETH (${hash.slice(0, 6)}…${hash.slice(-4)}): I haven't synced it yet`);
    });
  });

  it('"did you catch everything yesterday?" checks only the last day and says so', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
    const a = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 1_000_000n });
    await sync(wallet.id);
    await label(user.id, a);
    await executeTool(user.id, 'check_books_complete', { days: 1 });
    const text = await finished();
    expect(text).toMatch(/^I checked everything across your wallet over the last day \(\w{3} \d+, (up to )?\d\d:\d\d/);
  });

  it('a check interrupted by a restart is run again; one interrupted twice is reported', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
    const a = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 1_000_000n });
    await sync(wallet.id);
    await label(user.id, a);
    await sql(`INSERT INTO audit_runs (user_id, requested_by, status, attempts) VALUES ($1, $1, 'running', 1)`, [user.id]);

    expect(await recoverAudits()).toBe(1);
    const text = await finished();
    expect(text).toContain('Every supported movement reached your books.');
    expect((await sql<{ attempts: number; status: string }>(`SELECT attempts, status FROM audit_runs`))[0])
      .toEqual({ attempts: 2, status: 'complete' });

    await sql(`INSERT INTO audit_runs (user_id, requested_by, status, attempts) VALUES ($1, $1, 'running', 2)`, [user.id]);
    await recoverAudits();
    const twice = await finished(2);
    expect(twice).toMatch(/^I started checking your wallets at .+, but I was restarted before it finished, twice\. Nothing in the books has changed\. Ask me again and I'll run the check again\.$/);
  });

  it('an operator only ever sees their own wallets; a transaction of someone else is "not found"', async () => {
    const alice = await seedUserWithWallet({ username: 'alice' });
    const bob = await seedUserWithWallet({ username: 'bob' });
    const h = usdcTransfer(alice.wallet.address, { block: 900, from: addr(), to: alice.wallet.address, raw: 1_000_000n });
    await sync(alice.wallet.id);

    const forBob = await executeTool(bob.user.id, 'check_transaction', { hash: h });
    expect(forBob).toMatchObject({ found: false });
    const forAlice = await executeTool(alice.user.id, 'check_transaction', { hash: h });
    // Stored but not labeled yet: in the books, not missing
    expect(forAlice).toMatchObject({ found: true, movements: [{ amount: '1.00 USDC', direction: 'in', missing: false, status: "it's in your books but not labeled yet" }] });
  });

  it('an admin can check another operator\'s books by username; the result names them', async () => {
    const admin = await insertUser({ role: 'admin', username: 'founder' });
    const { user, wallet } = await seedUserWithWallet({ username: 'alice', timezone: 'UTC' });
    const a = usdcTransfer(wallet.address, { block: 900, from: addr(), to: wallet.address, raw: 1_000_000n });
    await sync(wallet.id);
    await label(user.id, a);

    expect(await executeAdminTool(admin.id, 'admin_check_books', { username: '@alice' })).toMatchObject({ status: 'started' });
    const text = await finished();
    expect(sent[0].to).toBe(admin.id);
    expect(text).toMatch(/across @alice's wallet (on|from) .+: 1 transaction, 1 supported financial movement\./);
    expect(text).toContain("Every supported movement reached @alice's books.");
    // An operator cannot use it
    expect(await executeAdminTool(user.id, 'admin_check_books', { username: 'founder' })).toEqual({ error: 'Not available.' });
  });
});
