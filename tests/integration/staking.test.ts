// Integration: staking recognised from the chain (migration 027). A transfer to or from a
// staking contract is labeled from the contract's staked amount for the wallet just before
// and just after the transaction. Real Postgres; the chain is scripted.
import { it, expect, vi, beforeEach } from 'vitest';

const llm = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/classification/llm.js', () => ({
  classifyWithLlmDetailed: vi.fn((events: Array<{ id: string }>) => {
    llm.calls += events.length;
    return Promise.resolve({
      results: new Map(events.map((e) => [e.id, { label: 'expense', confidence: 0.6, method: 'model', evidence: 'stub' }])),
      failures: new Map(),
    });
  }),
}));

import { describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassification, sql, addr, type WalletFx } from './helpers/db.js';
import { checkStakes, type StakingChain } from '../../src/staking/checks.js';
import { classifyPendingEvents } from '../../src/classification/engine.js';
import { getPnlSummary } from '../../src/books/query.js';
import { RpcError } from '../../src/ingestion/alchemy.js';

const BNKR = '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b';
const STAKE = '0x88470240ff0663faefa68b1d7621b472ddd9584a';
const K = 10n ** 18n;
const word = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const addressWord = (a: string): string => '0x' + a.slice(2).padStart(64, '0');

// The staking contract as the probe found it on Sep 28: stakingToken() and rewardsToken()
// are BNKR, stakeOf(address) reads a wallet's stake. `staked` maps block -> amount (the
// latest entry at or before a block applies).
function stakingChain(staked: Array<[number, bigint]>, opts: { down?: boolean } = {}): StakingChain & { calls: number } {
  const chain = {
    calls: 0,
    code: (a: string) => Promise.resolve(a === STAKE ? '0x6080' : '0x'),
    call: (to: string, data: string, block: number | 'latest') => {
      chain.calls++;
      if (opts.down) return Promise.reject(new Error('socket hang up'));
      if (to !== STAKE) return Promise.reject(new RpcError('eth_call', 3, 'execution reverted'));
      if (data === '0x72f702f3' || data === '0xd1af0c7d') return Promise.resolve(addressWord(BNKR));
      if (data.startsWith('0x42623360')) {
        const at = block === 'latest' ? Infinity : block;
        const amount = [...staked].reverse().find(([b]) => b <= at)?.[1] ?? 0n;
        return Promise.resolve(word(amount));
      }
      return Promise.reject(new RpcError('eth_call', 3, 'execution reverted'));
    },
  };
  return chain;
}

async function bnkr(wallet: WalletFx, direction: 'in' | 'out', amount: bigint, block: number, counterparty = STAKE, hash?: string) {
  const ev = await insertEvent({ wallet, direction, asset: 'BNKR', amount: (amount / K).toString(), usdValue: Number(amount / K) * 0.00042, counterparty, hash });
  await sql(`UPDATE normalized_events SET raw_amount = $2, block_number = $3 WHERE id = $1`, [ev.id, amount.toString(), block]);
  return ev;
}
const active = async (eventId: string) => (await sql<{ label: string; method: string; evidence: string }>(
  `SELECT label::text, method, evidence FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [eventId],
))[0];

describeDb('staking recognised from the chain (integration)', () => {
  useIntegrationDb();
  beforeEach(() => { llm.calls = 0; });

  it('Dan\'s stake (Sep 28): the AI\'s unknown becomes staked, and it is never spending', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const stake = await bnkr(wallet, 'out', 700_000n * K, 1000);
    await insertClassification({ eventId: stake.id, userId: user.id, label: 'unknown', method: 'model', confidence: 0.14 });

    expect(await checkStakes(stakingChain([[1000, 700_000n * K]]))).toBe(1);

    expect(await active(stake.id)).toEqual({
      label: 'staked', method: 'deterministic',
      evidence: 'Moved into the staking contract 0x8847…584a. The staked amount rose by exactly the amount sent (stakeOf(address)).',
    });
    const pnl = await getPnlSummary(user.id, 30);
    expect(pnl.expenses_usdc).toBe(0);
    expect(pnl.unknown_count).toBe(0);
    expect(await sql(`SELECT is_staking, staking_token, reward_token, reader_name FROM staking_contracts WHERE address = $1`, [STAKE]))
      .toEqual([{ is_staking: true, staking_token: BNKR, reward_token: BNKR, reader_name: 'stakeOf(address)' }]);
  });

  it('a new stake waits for the check instead of going to the AI, then is labeled staked', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const first = await bnkr(wallet, 'out', 100n * K, 900);
    await checkStakes(stakingChain([[900, 100n * K]]));
    await classifyPendingEvents(user.id);
    expect((await active(first.id)).label).toBe('staked');

    // The contract is known now: a second stake is held until its check, never guessed
    const second = await bnkr(wallet, 'out', 50n * K, 950);
    await classifyPendingEvents(user.id);
    expect(await active(second.id)).toBeUndefined();
    expect(llm.calls).toBe(0);

    await checkStakes(stakingChain([[900, 100n * K], [950, 150n * K]]));
    await classifyPendingEvents(user.id);
    expect((await active(second.id)).label).toBe('staked');
  });

  it('a reward is income apart from revenue; returned capital is never income', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await bnkr(wallet, 'out', 700_000n * K, 1000);
    const reward = await bnkr(wallet, 'in', 2_000n * K, 1100);
    const back = await bnkr(wallet, 'in', 700_000n * K, 1200);
    await checkStakes(stakingChain([[1000, 700_000n * K], [1200, 0n]]));
    await classifyPendingEvents(user.id);

    expect((await active(reward.id)).label).toBe('staking_reward');
    expect((await active(back.id)).label).toBe('unstaked');
    const pnl = await getPnlSummary(user.id, 30);
    // Only the reward is income: 2,000 BNKR at the fixture price
    expect(pnl.revenue_usdc).toBeCloseTo(2_000 * 0.00042, 6);
    expect(pnl.expenses_usdc).toBe(0);
  });

  it('BNKR back with the stake unchanged but not explained by what Luca saw staked stays unknown', async () => {
    const { user, wallet } = await seedUserWithWallet();
    // 900k staked before Luca watched; Luca never saw it going in
    const inflow = await bnkr(wallet, 'in', 900_000n * K, 1300);
    await checkStakes(stakingChain([[1, 900_000n * K]]));
    await classifyPendingEvents(user.id);
    expect(await active(inflow.id)).toMatchObject({ label: 'unknown', method: 'deterministic' });
    expect(llm.calls).toBe(0);
  });

  it('a plain account or another contract is asked once, then left to the usual labels', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const person = addr();
    const pay = await bnkr(wallet, 'out', 10n * K, 1400, person);
    const chain = stakingChain([]);
    expect(await checkStakes(chain)).toBe(0);
    expect(await sql(`SELECT is_staking FROM staking_contracts WHERE address = $1`, [person])).toEqual([{ is_staking: false }]);
    await classifyPendingEvents(user.id);
    expect((await active(pay.id)).label).toBe('expense');

    const calls = chain.calls;
    await bnkr(wallet, 'out', 20n * K, 1500, person);
    await checkStakes(chain);
    expect(chain.calls).toBe(calls);
  });

  it('a chain that does not answer changes nothing and is retried next cycle', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const stake = await bnkr(wallet, 'out', 700_000n * K, 1000);
    await insertClassification({ eventId: stake.id, userId: user.id, label: 'unknown', method: 'model' });
    await sql(`INSERT INTO staking_contracts (address, is_staking, staking_token, reward_token, position_reader, reader_name)
               VALUES ($1, TRUE, $2, $2, '0x42623360', 'stakeOf(address)')`, [STAKE, BNKR]);

    expect(await checkStakes(stakingChain([], { down: true }))).toBe(0);
    expect(await sql(`SELECT 1 FROM stake_checks`)).toHaveLength(0);
    expect((await active(stake.id)).label).toBe('unknown');

    expect(await checkStakes(stakingChain([[1000, 700_000n * K]]))).toBe(1);
    expect((await active(stake.id)).label).toBe('staked');
  });
});
