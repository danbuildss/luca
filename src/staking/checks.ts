import { query } from '../db.js';
import { logger } from '../logger.js';
import { ClassificationLabel } from '../types/index.js';
import { ethCall, getCode, RpcError } from '../ingestion/alchemy.js';
import { saveManyClassifications } from '../classification/store.js';
import type { ClassificationResult } from '../classification/types.js';

// Staking, recognised from the chain (migration 027). When a tracked token moves between
// an operator's wallet and a contract that names a staking token, Luca asks the contract
// how much that wallet had staked just before and just after the transaction:
//
//   staked          tokens went in and the staked amount rose by exactly that much. A
//                   capital movement: never an expense.
//   unstaked        tokens came back and the staked amount fell by exactly that much, or
//                   they match a withdrawal already requested (the staked amount is below
//                   what Luca saw going in). Capital coming back: never income.
//   staking_reward  reward tokens came back, the staked amount did not change, and it
//                   still equals exactly what Luca saw going in. Income, apart from
//                   creator-fee revenue.
//   unclear         the contract's numbers do not explain the transfer. Stays unknown and
//                   Luca asks: unknown is better than calling returned capital income.
//   unrelated       a token the contract neither stakes nor pays rewards in.
//
// Reads only: nothing here signs or sends anything.

export type StakeVerdict = 'staked' | 'unstaked' | 'staking_reward' | 'unclear' | 'unrelated';

export type StakingContract = {
  address: string;
  is_staking: boolean;
  staking_token: string | null;
  reward_token: string | null;
  position_reader: string | null;
  reader_name: string | null;
};

export type StakeEvidence = {
  contract: string;
  reader: string | null;
  block: string;
  staked_before: string | null;   // smallest units, from the contract
  staked_after: string | null;
  principal_seen: string;         // staked minus unstaked, from Luca's own checks before this block
  reason: string;
};

export type StakeLeg = { event_id: string; direction: 'in' | 'out'; token: string; amount_raw: bigint };

type Decision = { event_id: string; verdict: StakeVerdict; reason: string };

const STAKING_TOKEN_READ = '0x72f702f3'; // stakingToken()
const REWARD_TOKEN_READS: Array<[string, string]> = [
  ['0xd1af0c7d', 'rewardsToken()'],
  ['0xf7c618c1', 'rewardToken()'],
];
// Reads of one wallet's staked amount, tried in this order
const POSITION_READS: Array<[string, string]> = [
  ['0x42623360', 'stakeOf(address)'],
  ['0x16765391', 'stakedBalanceOf(address)'],
  ['0x60217267', 'stakedBalance(address)'],
];

const sum = (legs: StakeLeg[]): bigint => legs.reduce((t, l) => t + l.amount_raw, 0n);

// What one transaction's transfers between a wallet and a staking contract were, from the
// wallet's staked amount before and after it. Pure: every chain read happens before.
export function decideStakes(p: {
  contract: Pick<StakingContract, 'staking_token' | 'reward_token'>;
  legs: StakeLeg[];
  before: bigint;
  after: bigint;
  principalSeen: bigint;
}): Decision[] {
  const { contract, before, after, principalSeen } = p;
  const all = (legs: StakeLeg[], verdict: StakeVerdict, reason: string): Decision[] =>
    legs.map((l) => ({ event_id: l.event_id, verdict, reason }));

  const known = new Set([contract.staking_token, contract.reward_token].filter((t): t is string => !!t));
  const unrelated = p.legs.filter((l) => !known.has(l.token));
  const legs = p.legs.filter((l) => known.has(l.token));
  const out = all(unrelated, 'unrelated', 'The staking contract neither stakes nor pays rewards in this token');
  if (legs.length === 0) return out;

  if (new Set(legs.map((l) => l.direction)).size > 1) {
    return [...out, ...all(legs, 'unclear', 'Tokens went both into and out of the staking contract in one transaction')];
  }

  if (legs[0].direction === 'out') {
    const sent = sum(legs);
    if (legs.every((l) => l.token === contract.staking_token) && after - before === sent) {
      return [...out, ...all(legs, 'staked', 'The staked amount rose by exactly the amount sent')];
    }
    return [...out, ...all(legs, 'unclear', `The staked amount changed by ${after - before}, not by the ${sent} sent`)];
  }

  // Tokens came back. Capital first: a fall in the staked amount, or a withdrawal already
  // requested (the stake is below the capital Luca saw going in).
  const fell = before - after;
  const pending = fell > 0n ? fell : after === before && principalSeen > after ? principalSeen - after : 0n;
  if (fell < 0n) return [...out, ...all(legs, 'unclear', 'The staked amount rose while tokens came back')];

  const received = sum(legs);
  const reward = (l: StakeLeg): boolean => !!contract.reward_token && l.token === contract.reward_token;
  if (pending > 0n) {
    const capital = (l: StakeLeg): boolean => l.token === contract.staking_token;
    if (received === pending && legs.every(capital)) {
      return [...out, ...all(legs, 'unstaked', fell > 0n
        ? 'The staked amount fell by exactly the amount received'
        : 'It matches a withdrawal already requested: the stake is below what was staked')];
    }
    const match = legs.filter((l) => capital(l) && l.amount_raw === pending);
    if (match.length === 1 && legs.every((l) => l === match[0] || reward(l))) {
      return [...out, ...legs.map((l): Decision => l === match[0]
        ? { event_id: l.event_id, verdict: 'unstaked', reason: 'It matches the fall in the staked amount' }
        : { event_id: l.event_id, verdict: 'staking_reward', reason: 'Paid with the returned stake, beyond it' })];
    }
    return [...out, ...all(legs, 'unclear', `The ${received} received does not match the ${pending} of stake coming back`)];
  }

  // Nothing of the stake came back: a reward, but only when the stake is fully explained
  // by what Luca saw going in (otherwise it could be capital staked before Luca watched)
  if (after === principalSeen && after > 0n && legs.every(reward)) {
    return [...out, ...all(legs, 'staking_reward', 'The staked amount did not change and equals what was staked')];
  }
  return [...out, ...all(legs, 'unclear', after === principalSeen
    ? 'The staked amount did not change, but this is not the contract\'s reward token'
    : 'The staked amount did not change, and it differs from what Luca saw being staked')];
}

// The label a checked transfer gets (null: label it like any other transfer)
export function stakeLabel(check: { verdict: StakeVerdict; evidence: StakeEvidence }): ClassificationResult | null {
  const where = `staking contract ${short(check.evidence.contract)}`;
  const read = check.evidence.reader ? ` (${check.evidence.reader})` : '';
  switch (check.verdict) {
    case 'staked':
      return { label: ClassificationLabel.STAKED, confidence: 1.0, method: 'deterministic', evidence: `Moved into the ${where}. ${check.evidence.reason}${read}.` };
    case 'unstaked':
      return { label: ClassificationLabel.UNSTAKED, confidence: 1.0, method: 'deterministic', evidence: `Staked tokens back from the ${where}. ${check.evidence.reason}${read}.` };
    case 'staking_reward':
      return { label: ClassificationLabel.STAKING_REWARD, confidence: 1.0, method: 'deterministic', evidence: `Reward paid by the ${where}. ${check.evidence.reason}${read}.` };
    case 'unclear':
      return { label: ClassificationLabel.UNKNOWN, confidence: 0, method: 'deterministic', evidence: `Moved to or from the ${where}, but not explained: ${check.evidence.reason}. Needs your answer.` };
    default:
      return null;
  }
}

const short = (h: string): string => `${h.slice(0, 6)}…${h.slice(-4)}`;
const word = (hex: string): string | null => (/^0x[0-9a-fA-F]{64}/.test(hex) ? hex.slice(2, 66) : null);
const asAddress = (hex: string): string | null => {
  const w = word(hex);
  if (!w || !w.startsWith('000000000000000000000000') || /^0+$/.test(w)) return null;
  return `0x${w.slice(24)}`.toLowerCase();
};
const addressArg = (address: string): string => address.slice(2).toLowerCase().padStart(64, '0');

// The chain reads a check needs, injectable for tests
export type StakingChain = {
  code(address: string): Promise<string>;
  call(to: string, data: string, block: number | 'latest'): Promise<string>;
};

export function alchemyChain(apiKey: string): StakingChain {
  return { code: (a) => getCode(apiKey, a), call: (to, data, block) => ethCall(apiKey, to, data, block) };
}

// A call the contract rejects (it has no such function) is an answer; a network failure
// is not, and is thrown so the whole check is retried next cycle
async function tryCall(chain: StakingChain, to: string, data: string, block: number | 'latest'): Promise<string | null> {
  try {
    return await chain.call(to, data, block);
  } catch (err) {
    if (err instanceof RpcError) return null;
    throw err;
  }
}

// What a counterparty is, asked once and kept (a contract that names no staking token,
// or has no read of a wallet's stake, is kept as not staking)
export async function probeContract(chain: StakingChain, address: string, wallet: string): Promise<StakingContract> {
  const cached = (await query<StakingContract>(
    `SELECT address, is_staking, staking_token, reward_token, position_reader, reader_name FROM staking_contracts WHERE address = $1`,
    [address],
  )).rows[0];
  if (cached) return cached;

  const found: StakingContract = { address, is_staking: false, staking_token: null, reward_token: null, position_reader: null, reader_name: null };
  const code = await chain.code(address);
  if (code && code !== '0x') {
    const token = asAddress((await tryCall(chain, address, STAKING_TOKEN_READ, 'latest')) ?? '');
    if (token) {
      found.staking_token = token;
      for (const [sel] of REWARD_TOKEN_READS) {
        const r = asAddress((await tryCall(chain, address, sel, 'latest')) ?? '');
        if (r) { found.reward_token = r; break; }
      }
      for (const [sel, name] of POSITION_READS) {
        if (word((await tryCall(chain, address, sel + addressArg(wallet), 'latest')) ?? '')) {
          found.position_reader = sel;
          found.reader_name = name;
          break;
        }
      }
      found.is_staking = found.position_reader !== null;
    }
  }
  await query(
    `INSERT INTO staking_contracts (address, is_staking, staking_token, reward_token, position_reader, reader_name)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (address) DO NOTHING`,
    [address, found.is_staking, found.staking_token, found.reward_token, found.position_reader, found.reader_name],
  );
  return found;
}

type Candidate = {
  id: string; user_id: string; wallet_id: string; wallet: string; hash: string; direction: 'in' | 'out';
  token: string; amount_raw: string; block_number: string; counterparty: string;
};

// Token transfers between an operator's wallet and another address that have not been
// checked, skipping counterparties already known not to be staking contracts
async function candidates(limit: number): Promise<Candidate[]> {
  return (await query<Candidate>(
    `WITH ev AS (
       SELECT ne.id, ne.user_id, ne.wallet_id, LOWER(w.address) AS wallet, LOWER(ne.hash) AS hash, ne.direction,
              LOWER(ne.token_address) AS token, ne.raw_amount::text AS amount_raw, ne.block_number::text AS block_number,
              LOWER(CASE WHEN ne.direction = 'out' THEN ne.to_address ELSE ne.from_address END) AS counterparty
       FROM normalized_events ne
       JOIN wallets w ON w.id = ne.wallet_id AND w.active = TRUE
       WHERE ne.supported IS TRUE AND ne.token_address IS NOT NULL AND ne.raw_amount > 0
         AND ne.block_number IS NOT NULL AND ne.source_key IS DISTINCT FROM 'gas'
         AND NOT EXISTS (SELECT 1 FROM stake_checks k WHERE k.event_id = ne.id)
     )
     SELECT ev.* FROM ev
     WHERE ev.counterparty IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM staking_contracts sc WHERE sc.address = ev.counterparty AND NOT sc.is_staking)
       AND NOT EXISTS (SELECT 1 FROM wallets o WHERE o.user_id = ev.user_id AND LOWER(o.address) = ev.counterparty)
     ORDER BY ev.block_number::bigint
     LIMIT $1`,
    [limit],
  )).rows;
}

// All of a transaction's token transfers between one wallet and one counterparty
async function transactionLegs(walletId: string, hash: string, counterparty: string): Promise<Candidate[]> {
  return (await query<Candidate>(
    `SELECT ne.id, ne.user_id, ne.wallet_id, LOWER(w.address) AS wallet, LOWER(ne.hash) AS hash, ne.direction,
            LOWER(ne.token_address) AS token, ne.raw_amount::text AS amount_raw, ne.block_number::text AS block_number,
            $3::text AS counterparty
     FROM normalized_events ne JOIN wallets w ON w.id = ne.wallet_id
     WHERE ne.wallet_id = $1 AND LOWER(ne.hash) = $2 AND ne.supported IS TRUE AND ne.token_address IS NOT NULL
       AND ne.raw_amount > 0 AND ne.source_key IS DISTINCT FROM 'gas'
       AND LOWER(CASE WHEN ne.direction = 'out' THEN ne.to_address ELSE ne.from_address END) = $3
       AND NOT EXISTS (SELECT 1 FROM stake_checks k WHERE k.event_id = ne.id)`,
    [walletId, hash, counterparty],
  )).rows;
}

// Capital Luca has seen go into a contract from a wallet, less what came back, before a block
async function principalSeen(walletId: string, contract: string, block: bigint): Promise<bigint> {
  const r = (await query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE verdict WHEN 'staked' THEN amount_raw WHEN 'unstaked' THEN -amount_raw ELSE 0 END), 0)::text AS net
     FROM stake_checks WHERE wallet_id = $1 AND contract = $2 AND block_number < $3`,
    [walletId, contract, block.toString()],
  )).rows[0];
  return BigInt(r?.net ?? '0');
}

// Checks up to `limit` unchecked transfers; returns how many were decided
export async function checkStakes(chain: StakingChain, limit = 50): Promise<number> {
  const groups = new Map<string, Candidate>();
  for (const c of await candidates(limit)) groups.set(`${c.wallet_id}:${c.hash}:${c.counterparty}`, groups.get(`${c.wallet_id}:${c.hash}:${c.counterparty}`) ?? c);

  let decided = 0;
  for (const first of groups.values()) {
    try {
      const contract = await probeContract(chain, first.counterparty, first.wallet);
      if (!contract.is_staking || !contract.position_reader) continue;

      const legs = await transactionLegs(first.wallet_id, first.hash, first.counterparty);
      if (legs.length === 0) continue;
      const block = BigInt(first.block_number);
      const read = async (at: bigint): Promise<bigint> => {
        const hex = await chain.call(contract.address, contract.position_reader! + addressArg(first.wallet), Number(at));
        const w = word(hex);
        if (!w) throw new Error(`Unreadable staked amount from ${contract.address}`);
        return BigInt(`0x${w}`);
      };
      const [before, after, principal] = await Promise.all([read(block - 1n), read(block), principalSeen(first.wallet_id, contract.address, block)]);

      const decisions = decideStakes({
        contract,
        legs: legs.map((l) => ({ event_id: l.id, direction: l.direction, token: l.token, amount_raw: BigInt(l.amount_raw) })),
        before, after, principalSeen: principal,
      });
      for (const d of decisions) {
        const leg = legs.find((l) => l.id === d.event_id)!;
        const evidence: StakeEvidence = {
          contract: contract.address, reader: contract.reader_name, block: block.toString(),
          staked_before: before.toString(), staked_after: after.toString(), principal_seen: principal.toString(), reason: d.reason,
        };
        const inserted = await query(
          `INSERT INTO stake_checks (event_id, user_id, wallet_id, contract, verdict, amount_raw, block_number, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (event_id) DO NOTHING`,
          [leg.id, leg.user_id, leg.wallet_id, contract.address, d.verdict, leg.amount_raw, block.toString(), JSON.stringify(evidence)],
        );
        if (inserted.rowCount === 1) {
          decided++;
          await relabelChecked(leg.user_id, leg.id, { verdict: d.verdict, evidence });
        }
      }
    } catch (err) {
      logger.warn({ err, hash: first.hash, counterparty: first.counterparty }, 'Stake check: chain not readable, retrying next cycle');
    }
  }
  return decided;
}

// Which of these addresses are staking contracts Luca already knows
export async function knownStakingContracts(addresses: string[]): Promise<Set<string>> {
  const list = [...new Set(addresses.filter(Boolean))];
  if (list.length === 0) return new Set();
  const res = await query<{ address: string }>(
    `SELECT address FROM staking_contracts WHERE is_staking AND address = ANY($1::text[])`,
    [list],
  );
  return new Set(res.rows.map((r) => r.address));
}

export async function getStakeChecks(eventIds: string[]): Promise<Map<string, { verdict: StakeVerdict; evidence: StakeEvidence }>> {
  const out = new Map<string, { verdict: StakeVerdict; evidence: StakeEvidence }>();
  if (eventIds.length === 0) return out;
  const res = await query<{ event_id: string; verdict: StakeVerdict; evidence: StakeEvidence }>(
    `SELECT event_id, verdict, evidence FROM stake_checks WHERE event_id = ANY($1::uuid[])`,
    [eventIds],
  );
  for (const r of res.rows) out.set(r.event_id, r);
  return out;
}

// A transfer already labeled automatically takes the checked label now. The operator's
// own labels are never touched (saveManyClassifications), and swaps or mixed transactions
// keep what their shape decided.
async function relabelChecked(userId: string, eventId: string, check: { verdict: StakeVerdict; evidence: StakeEvidence }): Promise<void> {
  const result = stakeLabel(check);
  if (!result) return;
  const active = (await query<{ id: string; label: string; method: string }>(
    `SELECT id, label, method FROM classifications
     WHERE event_id = $1 AND user_id = $2 AND superseded_at IS NULL AND source IS NULL
       AND (shape IS NULL OR shape = 'single')`,
    [eventId, userId],
  )).rows;
  if (active.length !== 1) return;
  const a = active[0];
  if (a.label === result.label && a.method === result.method) return;
  await saveManyClassifications([{ event_id: eventId, user_id: userId, ...result, shape: 'single', expected_active_id: a.id }]);
}
