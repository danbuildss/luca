// Integration: $ACCUM creator fees (migration 025). What Bankr reports is kept as
// "reported"; a BNKR transfer into the fee wallet becomes revenue with ACCUM provenance
// only when its receipt ties it to the ACCUM pool, and stays unknown when the fee contract
// is involved but the evidence is not enough. Real Postgres; Bankr and the chain are faked.
import { it, expect, vi, beforeEach } from 'vitest';

const llm = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/classification/llm.js', () => ({
  classifyWithLlmDetailed: vi.fn((events: Array<{ id: string }>) => {
    llm.calls += events.length;
    return Promise.resolve({
      results: new Map(events.map((e) => [e.id, { label: 'revenue', confidence: 0.7, method: 'model', evidence: 'stub' }])),
      failures: new Map(),
    });
  }),
}));

import {
  describeDb, useIntegrationDb, insertUser, insertWallet, insertWatchJob, insertEvent, insertClassification,
  insertCounterpartyRule, sql, addr, type WalletFx,
} from './helpers/db.js';
import { ACCUM, ACCUM_RESPONSE } from '../fees/fixtures.js';
import { parseTokenFees, BankrUnavailable, type BankrTokenFees } from '../../src/fees/bankr.js';
import { addFeeSource, readDueFeeSources, feeSourceStatus, allActiveSources, type FeeSource } from '../../src/fees/sources.js';
import { checkFeeClaims } from '../../src/fees/claims.js';
import { classifyPendingEvents } from '../../src/classification/engine.js';
import type { TxReceipt } from '../../src/ingestion/alchemy.js';

const LUCA_WALLET = ACCUM_RESPONSE.address;
const POOL = ACCUM_RESPONSE.tokens[0].poolId;
const FEES = ACCUM_RESPONSE.tokens[0].feesContract;
const OTHER_POOL = '0x' + '11'.repeat(32);
const SIG = '0x' + 'ab'.repeat(32);

type Response = typeof ACCUM_RESPONSE;
const bankr = (patch: Partial<Response['tokens'][0]> = {}, top: Partial<Response> = {}) =>
  (token: string): Promise<BankrTokenFees> =>
    Promise.resolve(parseTokenFees({ ...ACCUM_RESPONSE, ...top, tokens: [{ ...ACCUM_RESPONSE.tokens[0], ...patch }] }, token));
const unavailable = (): Promise<BankrTokenFees> => Promise.reject(new BankrUnavailable('Bankr did not answer within 10 seconds'));

const receipts = new Map<string, Array<{ address: string; topics: string[] }> | 'error'>();
const getReceipt = (_key: string, hash: string): Promise<TxReceipt | null> => {
  const logs = receipts.get(hash);
  if (logs === 'error') return Promise.reject(new Error('rpc down'));
  return Promise.resolve({ status: 'success', raw: { logs: logs ?? [] } } as unknown as TxReceipt);
};

async function setup(): Promise<{ userId: string; wallet: WalletFx; source: FeeSource }> {
  const user = await insertUser();
  const wallet = await insertWallet({ userId: user.id, address: LUCA_WALLET });
  await insertWatchJob({ userId: user.id, walletId: wallet.id, lastSyncedAt: '5 minutes' });
  const added = await addFeeSource({ walletAddress: LUCA_WALLET, token: ACCUM }, bankr());
  if (!added.ok) throw new Error(added.error);
  return { userId: user.id, wallet, source: added.source };
}

// A BNKR transfer into the fee wallet, with its exact on-chain amount
async function bnkrIn(wallet: WalletFx, from: string, amount: string, logs: Array<{ address: string; topics: string[] }> | 'error' = []) {
  const ev = await insertEvent({ wallet, direction: 'in', counterparty: from, asset: 'BNKR', amount });
  await sql(`UPDATE normalized_events SET raw_amount = ($2::numeric * 10::numeric ^ 18) WHERE id = $1`, [ev.id, amount]);
  receipts.set(ev.hash, logs);
  return ev;
}

async function labelOf(eventId: string) {
  return (await sql<{ label: string; method: string; source: string | null; fee_source_id: string | null; evidence: string }>(
    `SELECT label::text, method, source, fee_source_id, evidence FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [eventId],
  ))[0] ?? null;
}

describeDb('ACCUM creator fees (integration)', () => {
  useIntegrationDb();
  beforeEach(() => { receipts.clear(); llm.calls = 0; });

  it('adds the source from Bankr, checked, with a first reading kept as reported', async () => {
    const { source } = await setup();
    expect(source).toMatchObject({
      wallet_address: LUCA_WALLET, token_address: ACCUM, token_symbol: 'ACCUM', pool_id: POOL,
      fee_contract: FEES, fee_asset: 'BNKR', fee_token: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b',
    });
    const [s] = await feeSourceStatus(source.user_id);
    expect(s.reported).toMatchObject({ claimable: '2713229.471936', claimed: '0', claim_count: 0 });
    expect(s.last_error).toBeNull();
    expect(s.reconciliation).toEqual({ status: 'match', claimed: '0', count: 0 });

    // Adding it again changes nothing
    expect(await addFeeSource({ walletAddress: LUCA_WALLET, token: ACCUM }, bankr())).toMatchObject({ ok: true, created: false });
  });

  it('refuses a source it cannot verify', async () => {
    const user = await insertUser();
    const other = await insertWallet({ userId: user.id });
    expect(await addFeeSource({ walletAddress: addr(), token: ACCUM }, bankr())).toMatchObject({ ok: false, error: expect.stringMatching(/^Luca is not tracking/) as string });
    expect(await addFeeSource({ walletAddress: other.address, token: ACCUM }, bankr()))
      .toEqual({ ok: false, error: `Bankr pays these fees to ${LUCA_WALLET}, not ${other.address}` });
    await insertWallet({ userId: user.id, address: LUCA_WALLET });
    expect(await addFeeSource({ walletAddress: LUCA_WALLET, token: ACCUM }, bankr({ numeraire: addr() })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/which Luca does not track$/) as string });
    expect(await addFeeSource({ walletAddress: LUCA_WALLET, token: ACCUM }, unavailable))
      .toEqual({ ok: false, error: 'Bankr did not answer within 10 seconds' });
    expect(await sql(`SELECT 1 FROM fee_sources`)).toHaveLength(0);
  });

  it('reads hourly; a failed read keeps the last good reading and says why; a changed pool stops the readings', async () => {
    const { source } = await setup();
    expect(await readDueFeeSources(bankr())).toBe(0); // read a moment ago

    await sql(`UPDATE fee_source_readings SET read_at = NOW() - INTERVAL '3 hours'`);
    expect(await readDueFeeSources(unavailable)).toBe(1);
    let [s] = await feeSourceStatus(source.user_id);
    expect(s.reported).toMatchObject({ claimable: '2713229.471936' });
    expect(s.reported_stale).toBe(true);
    expect(s.last_error).toMatchObject({ error: 'Bankr did not answer within 10 seconds' });

    await sql(`UPDATE fee_source_readings SET read_at = read_at - INTERVAL '2 hours'`);
    await readDueFeeSources(bankr({ poolId: OTHER_POOL }));
    [s] = await feeSourceStatus(source.user_id);
    expect(s.last_error?.error).toBe(`Bankr now reports a different pool ${OTHER_POOL} for ACCUM; readings are paused until an admin checks it`);
    expect(s.reported).toMatchObject({ claimable: '2713229.471936' }); // the mismatched numbers are never used
  });

  it('claimable change is between readings, and says when it covers less than a day', async () => {
    const { source } = await setup();
    await sql(`UPDATE fee_source_readings SET read_at = NOW() - INTERVAL '26 hours'`);
    await sql(
      `INSERT INTO fee_source_readings (fee_source_id, status, claimable, claimed, claim_count, read_at)
       VALUES ($1, 'ok', 2713300.5, 0, 0, NOW() - INTERVAL '25 hours'), ($1, 'ok', 2714229.471936, 0, 0, NOW() - INTERVAL '10 minutes')`,
      [source.id],
    );
    // From the last reading at least a day before the latest (25 hours ago)
    let [s] = await feeSourceStatus(source.user_id);
    expect(s.claimable_change).toMatchObject({ change: '928.971936', full_day: true });

    await sql(`DELETE FROM fee_source_readings WHERE read_at < NOW() - INTERVAL '24 hours'`);
    await sql(`INSERT INTO fee_source_readings (fee_source_id, status, claimable, claimed, claim_count, read_at)
               VALUES ($1, 'ok', 2714000, 0, 0, NOW() - INTERVAL '5 hours')`, [source.id]);
    [s] = await feeSourceStatus(source.user_id);
    expect(s.claimable_change).toMatchObject({ change: '229.471936', full_day: false });
  });

  it('a claim: held until its receipt is read, then revenue tied to ACCUM; Bankr and the chain are reconciled', async () => {
    const { userId, wallet, source } = await setup();
    const ev = await bnkrIn(wallet, FEES, '1234.567890123456789');

    // Before the check: no label at all, and never the model
    await classifyPendingEvents(userId);
    expect(await labelOf(ev.id)).toBeNull();
    expect(llm.calls).toBe(0);

    expect(await checkFeeClaims('key', await allActiveSources(), getReceipt)).toBe(1);
    await classifyPendingEvents(userId);
    const l = await labelOf(ev.id);
    expect(l).toMatchObject({ label: 'revenue', method: 'deterministic', source: null, fee_source_id: source.id });
    expect(l?.evidence).toBe("ACCUM creator fees claimed from Bankr's fee contract 0x9982…fdbb (pool 0xf50f…37eb). Paid by the fee contract.");
    expect(llm.calls).toBe(0);

    // Bankr still reports nothing claimed: surfaced, never smoothed over
    let [s] = await feeSourceStatus(userId);
    expect(s.verified).toMatchObject({ count: 1, total: '1234.567890123456789', last: { hash: ev.hash, amount: '1234.567890123456789' } });
    expect(s.reconciliation).toEqual({
      status: 'mismatch', reported_claimed: '0', reported_count: 0, verified_claimed: '1234.567890123456789', verified_count: 1,
      difference: '-1234.567890123456789',
    });

    // Bankr catches up (it reports 6 decimals)
    await sql(`UPDATE fee_source_readings SET read_at = NOW() - INTERVAL '2 hours'`);
    await readDueFeeSources(bankr({ claimed: { token0: '1234.567890', token1: '0', count: 1 } }));
    [s] = await feeSourceStatus(userId);
    expect(s.reconciliation).toEqual({ status: 'match', claimed: '1234.56789', count: 1 });

    // Checked once; a later cycle reuses the check
    expect(await checkFeeClaims('key', await allActiveSources(), getReceipt)).toBe(0);
  });

  it('the fee contract is involved but another pool is too: unknown, never revenue', async () => {
    const { userId, wallet } = await setup();
    const ev = await bnkrIn(wallet, FEES, '50', [
      { address: FEES, topics: [SIG, POOL] },
      { address: FEES, topics: [SIG, OTHER_POOL] },
    ]);
    await checkFeeClaims('key', await allActiveSources(), getReceipt);
    await classifyPendingEvents(userId);
    expect(await labelOf(ev.id)).toMatchObject({ label: 'unknown', method: 'deterministic', fee_source_id: null });
    const [s] = await feeSourceStatus(userId);
    expect(s).toMatchObject({ unclear: 1, verified: { count: 0, total: '0' } });
  });

  it('BNKR from anyone else is labeled as usual, with no ACCUM provenance', async () => {
    const { userId, wallet } = await setup();
    const client = addr();
    await insertCounterpartyRule({ userId, address: client, label: 'revenue', direction: 'in' });
    const ev = await bnkrIn(wallet, client, '10');
    await checkFeeClaims('key', await allActiveSources(), getReceipt);
    await classifyPendingEvents(userId);
    expect(await labelOf(ev.id)).toMatchObject({ label: 'revenue', method: 'counterparty', fee_source_id: null });
    expect((await sql(`SELECT verdict FROM fee_claim_checks WHERE event_id = $1`, [ev.id]))[0]).toEqual({ verdict: 'unrelated' });
  });

  it("a claim already labeled by the model takes the checked label; the operator's own label is never touched", async () => {
    const { userId, wallet, source } = await setup();
    const byModel = await bnkrIn(wallet, FEES, '5');
    await insertClassification({ eventId: byModel.id, userId, label: 'expense', method: 'model' });
    const byOperator = await bnkrIn(wallet, FEES, '6');
    await insertClassification({ eventId: byOperator.id, userId, label: 'treasury', method: 'counterparty', source: 'user' });

    await checkFeeClaims('key', await allActiveSources(), getReceipt);
    expect(await labelOf(byModel.id)).toMatchObject({ label: 'revenue', method: 'deterministic', fee_source_id: source.id });
    expect(await labelOf(byOperator.id)).toMatchObject({ label: 'treasury', source: 'user', fee_source_id: null });
  });

  it('a receipt that cannot be read now leaves the transfer unchecked and unlabeled until the next cycle', async () => {
    const { userId, wallet } = await setup();
    const ev = await bnkrIn(wallet, FEES, '7', 'error');
    expect(await checkFeeClaims('key', await allActiveSources(), getReceipt)).toBe(0);
    await classifyPendingEvents(userId);
    expect(await labelOf(ev.id)).toBeNull();

    receipts.set(ev.hash, []);
    expect(await checkFeeClaims('key', await allActiveSources(), getReceipt)).toBe(1);
    await classifyPendingEvents(userId);
    expect(await labelOf(ev.id)).toMatchObject({ label: 'revenue' });
  });

  it('two tokens named ACCUM pay this wallet: only the pool named in the transaction counts', async () => {
    const { userId, wallet, source } = await setup();
    const OTHER_ACCUM = '0x0b3cbdb989a6a107add7a68cf72d13c32aa90ba3';
    const second = await addFeeSource({ walletAddress: LUCA_WALLET, token: OTHER_ACCUM }, bankr({ tokenAddress: OTHER_ACCUM, poolId: OTHER_POOL }));
    expect(second).toMatchObject({ ok: true, source: { token_symbol: 'ACCUM', pool_id: OTHER_POOL } });

    const named = await bnkrIn(wallet, FEES, '11', [{ address: FEES, topics: [SIG, POOL] }]);
    const unnamed = await bnkrIn(wallet, FEES, '12');
    await checkFeeClaims('key', await allActiveSources(), getReceipt);
    await classifyPendingEvents(userId);
    expect(await labelOf(named.id)).toMatchObject({ label: 'revenue', fee_source_id: source.id });
    expect(await labelOf(unnamed.id)).toMatchObject({ label: 'unknown', fee_source_id: null });
    expect((await labelOf(unnamed.id))?.evidence).toBe(
      'Possibly ACCUM creator fees, but not proven: The fee contract pays 2 tracked tokens to this wallet and nothing in the transaction says which one. Needs your answer.',
    );
  });

  it('another operator tracking the same wallet gets nothing from this source', async () => {
    const { userId } = await setup();
    const other = await insertUser();
    const theirs = await insertWallet({ userId: other.id, address: LUCA_WALLET });
    await insertWatchJob({ userId: other.id, walletId: theirs.id, lastSyncedAt: '5 minutes' });
    const ev = await bnkrIn(theirs, FEES, '9');

    expect(await checkFeeClaims('key', await allActiveSources(), getReceipt)).toBe(0);
    await classifyPendingEvents(other.id);
    expect(await labelOf(ev.id)).toMatchObject({ label: 'revenue', method: 'model', fee_source_id: null });
    expect(await feeSourceStatus(other.id)).toEqual([]);
    expect(await feeSourceStatus(userId)).toHaveLength(1);
  });
});
