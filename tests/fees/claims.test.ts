import { describe, it, expect } from 'vitest';
import { decideClaim, decideAcrossSources, feeLabel } from '../../src/fees/claims.js';
import type { FeeSource } from '../../src/fees/sources.js';

const POOL = '0xf50f308dde18f40b30b9f818f3afead3c67cafd82e695f0ad0d2c8444dea37eb';
const OTHER_POOL = '0x1111111111111111111111111111111111111111111111111111111111111111';
const FEES = '0x9982538f41f2ae29ddb9d3d9307010052984fdbb';
const source = { id: 'src-1', token_symbol: 'ACCUM', pool_id: POOL, fee_contract: FEES };
const SIG = '0x' + 'ab'.repeat(32);
const addressTopic = (a: string): string => '0x' + a.slice(2).padStart(64, '0');
const feeLog = (topic1: string) => ({ address: FEES.toUpperCase().replace('0X', '0x'), topics: [SIG, topic1] });
const ok = (...logs: Array<{ address: string; topics: string[] }>) => ({ status: 'success' as const, logs });

describe('is a BNKR transfer into the fee wallet an ACCUM creator-fee claim?', () => {
  it('paid by the fee contract, with nothing from another pool: a claim', () => {
    expect(decideClaim(source, { from_address: FEES }, ok()).verdict).toBe('claim');
    expect(decideClaim(source, { from_address: FEES }, ok(feeLog(POOL))).evidence.reason)
      .toBe('Paid by the fee contract, which recorded this pool in the same transaction');
  });

  it('paid through another contract, but the fee contract recorded this pool: a claim', () => {
    const r = decideClaim(source, { from_address: '0x' + '42'.repeat(20) }, ok(feeLog(POOL)));
    expect(r).toEqual({
      verdict: 'claim',
      evidence: { from_fee_contract: false, fee_contract_events: 1, pool_events: 1, other_pools: [], reason: 'The fee contract recorded this pool in the same transaction' },
    });
  });

  it('another pool in the same transaction (e.g. the other token named ACCUM): unclear, never revenue', () => {
    const r = decideClaim(source, { from_address: FEES }, ok(feeLog(POOL), feeLog(OTHER_POOL)));
    expect(r.verdict).toBe('unclear');
    expect(r.evidence.other_pools).toEqual([OTHER_POOL]);
    expect(feeLabel(source, r)).toMatchObject({ label: 'unknown', confidence: 0, method: 'deterministic' });
    expect(feeLabel(source, r)?.evidence).toBe('Possibly ACCUM creator fees, but not proven: The fee contract also recorded another pool in this transaction. Needs your answer.');
  });

  it('the fee contract is involved but names no pool (only addresses): unclear', () => {
    const r = decideClaim(source, { from_address: '0x' + '42'.repeat(20) }, ok(feeLog(addressTopic(FEES))));
    expect(r.verdict).toBe('unclear');
  });

  it('the fee contract is not involved: unrelated, labeled like any other transfer', () => {
    const r = decideClaim(source, { from_address: '0x' + '42'.repeat(20) }, ok({ address: '0x' + '55'.repeat(20), topics: [SIG, POOL] }));
    expect(r.verdict).toBe('unrelated');
    expect(feeLabel(source, r)).toBeNull();
  });

  it('a failed transaction is never a claim', () => {
    expect(decideClaim(source, { from_address: FEES }, { status: 'failed', logs: [feeLog(POOL)] }).verdict).toBe('unrelated');
  });

  it('a claim is revenue, tied to the fee source, with the evidence in words', () => {
    const r = decideClaim(source, { from_address: FEES }, ok());
    expect(feeLabel(source, r)).toEqual({
      label: 'revenue',
      confidence: 1,
      method: 'deterministic',
      evidence: "ACCUM creator fees claimed from Bankr's fee contract 0x9982…fdbb (pool 0xf50f…37eb). Paid by the fee contract.",
      fee_source_id: 'src-1',
    });
  });
});

describe('two tokens paying the same wallet through the same fee contract (the two ACCUMs)', () => {
  const accum = { ...source, id: 'accum' } as FeeSource;
  const other = { ...source, id: 'other-accum', pool_id: OTHER_POOL } as FeeSource;

  it('the pool named in the transaction decides which one', () => {
    const r = decideAcrossSources([accum, other], { from_address: FEES }, ok(feeLog(POOL)));
    expect(r).toMatchObject({ source: { id: 'accum' }, verdict: 'claim', evidence: { reason: 'The fee contract recorded this pool, and no other, in the same transaction' } });
    expect(decideAcrossSources([accum, other], { from_address: '0x' + '42'.repeat(20) }, ok(feeLog(OTHER_POOL))))
      .toMatchObject({ source: { id: 'other-accum' }, verdict: 'claim' });
  });

  it('both pools, or a pool Luca does not follow: unclear', () => {
    expect(decideAcrossSources([accum, other], { from_address: FEES }, ok(feeLog(POOL), feeLog(OTHER_POOL))))
      .toMatchObject({ verdict: 'unclear', evidence: { reason: 'The fee contract recorded 2 tracked pools in this transaction' } });
    expect(decideAcrossSources([accum, other], { from_address: FEES }, ok(feeLog(POOL), feeLog('0x' + '77'.repeat(32)))))
      .toMatchObject({ verdict: 'unclear', evidence: { reason: 'The fee contract also recorded a pool Luca does not follow in this transaction' } });
  });

  it('the fee contract not involved: unrelated', () => {
    expect(decideAcrossSources([accum, other], { from_address: '0x' + '42'.repeat(20) }, ok()).verdict).toBe('unrelated');
  });

  it('paid by the shared fee contract with no pool named: unclear, never guessed', () => {
    const r = decideAcrossSources([accum, other], { from_address: FEES }, ok());
    expect(r.verdict).toBe('unclear');
    expect(r.evidence.reason).toBe('The fee contract pays 2 tracked tokens to this wallet and nothing in the transaction says which one');
  });

  it('with one source, its own decision stands', () => {
    expect(decideAcrossSources([accum], { from_address: FEES }, ok())).toMatchObject({ source: { id: 'accum' }, verdict: 'claim' });
  });
});
