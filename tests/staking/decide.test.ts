import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));

import { decideStakes, stakeLabel, type StakeLeg } from '../../src/staking/checks.js';

// Staking decided from the contract's staked amount before and after (src/staking/checks.ts)

const BNKR = '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const contract = { staking_token: BNKR, reward_token: BNKR };
const K = 10n ** 18n;
const leg = (event_id: string, direction: 'in' | 'out', amount: bigint, token = BNKR): StakeLeg => ({ event_id, direction, token, amount_raw: amount });
const verdicts = (d: Array<{ event_id: string; verdict: string }>): Record<string, string> => Object.fromEntries(d.map((x) => [x.event_id, x.verdict]));

describe('decideStakes', () => {
  it('Dan\'s stake (Sep 28): 700,000 BNKR out, staked amount 0 -> 700,000', () => {
    const d = decideStakes({ contract, legs: [leg('a', 'out', 700_000n * K)], before: 0n, after: 700_000n * K, principalSeen: 0n });
    expect(d).toEqual([{ event_id: 'a', verdict: 'staked', reason: 'The staked amount rose by exactly the amount sent' }]);
  });

  it('tokens sent without the staked amount rising by as much stay unclear', () => {
    const d = decideStakes({ contract, legs: [leg('a', 'out', 700_000n * K)], before: 0n, after: 0n, principalSeen: 0n });
    expect(verdicts(d)).toEqual({ a: 'unclear' });
  });

  it('a reward: tokens back, stake unchanged and equal to what was staked', () => {
    const d = decideStakes({ contract, legs: [leg('r', 'in', 1_234n * K)], before: 700_000n * K, after: 700_000n * K, principalSeen: 700_000n * K });
    expect(verdicts(d)).toEqual({ r: 'staking_reward' });
  });

  it('never a reward when the stake is not fully explained by what Luca saw staked', () => {
    // 900k staked, but Luca only saw 700k going in (the rest was staked before it watched)
    const d = decideStakes({ contract, legs: [leg('r', 'in', 50_000n * K)], before: 900_000n * K, after: 900_000n * K, principalSeen: 700_000n * K });
    expect(verdicts(d)).toEqual({ r: 'unclear' });
  });

  it('unstaking: the staked amount falls by exactly what comes back', () => {
    const d = decideStakes({ contract, legs: [leg('u', 'in', 700_000n * K)], before: 700_000n * K, after: 0n, principalSeen: 700_000n * K });
    expect(verdicts(d)).toEqual({ u: 'unstaked' });
  });

  it('a withdrawal after an unstake request: stake already fell, the capital comes back later', () => {
    // requestUnstake took the stake to 0 with no transfer; the withdrawal changes nothing
    const d = decideStakes({ contract, legs: [leg('w', 'in', 700_000n * K)], before: 0n, after: 0n, principalSeen: 700_000n * K });
    expect(d[0]).toMatchObject({ verdict: 'unstaked', reason: 'It matches a withdrawal already requested: the stake is below what was staked' });
  });

  it('never calls returned capital a reward, even after a request', () => {
    const d = decideStakes({ contract, legs: [leg('w', 'in', 400_000n * K)], before: 0n, after: 0n, principalSeen: 700_000n * K });
    expect(verdicts(d)).toEqual({ w: 'unclear' });
  });

  it('exit: capital and reward in two transfers are told apart', () => {
    const d = decideStakes({
      contract,
      legs: [leg('cap', 'in', 700_000n * K), leg('rew', 'in', 9_000n * K)],
      before: 700_000n * K, after: 0n, principalSeen: 700_000n * K,
    });
    expect(verdicts(d)).toEqual({ cap: 'unstaked', rew: 'staking_reward' });
  });

  it('a token the contract neither stakes nor pays in is unrelated', () => {
    const d = decideStakes({ contract, legs: [leg('x', 'in', 5n * 10n ** 6n, USDC)], before: 1n, after: 1n, principalSeen: 1n });
    expect(verdicts(d)).toEqual({ x: 'unrelated' });
  });

  it('tokens going both ways, or the stake rising while tokens come back, stay unclear', () => {
    expect(verdicts(decideStakes({ contract, legs: [leg('a', 'out', K), leg('b', 'in', K)], before: 0n, after: 0n, principalSeen: 0n }))).toEqual({ a: 'unclear', b: 'unclear' });
    expect(verdicts(decideStakes({ contract, legs: [leg('b', 'in', K)], before: 0n, after: 5n * K, principalSeen: 0n }))).toEqual({ b: 'unclear' });
  });

  it('no reward token known: tokens back with the stake unchanged stay unclear', () => {
    const d = decideStakes({ contract: { staking_token: BNKR, reward_token: null }, legs: [leg('r', 'in', K)], before: K, after: K, principalSeen: K });
    expect(verdicts(d)).toEqual({ r: 'unclear' });
  });
});

describe('stakeLabel', () => {
  const evidence = { contract: '0x88470240ff0663faefa68b1d7621b472ddd9584a', reader: 'stakeOf(address)', block: '1', staked_before: '0', staked_after: '1', principal_seen: '0', reason: 'The staked amount rose by exactly the amount sent' };

  it('staked is a deterministic capital movement with the contract\'s reading as proof', () => {
    expect(stakeLabel({ verdict: 'staked', evidence })).toEqual({
      label: 'staked', confidence: 1, method: 'deterministic',
      evidence: 'Moved into the staking contract 0x8847…584a. The staked amount rose by exactly the amount sent (stakeOf(address)).',
    });
  });

  it('unclear stays unknown and asks; unrelated is left to the usual labels', () => {
    expect(stakeLabel({ verdict: 'unclear', evidence })).toMatchObject({ label: 'unknown', method: 'deterministic', confidence: 0 });
    expect(stakeLabel({ verdict: 'unrelated', evidence })).toBeNull();
  });
});
