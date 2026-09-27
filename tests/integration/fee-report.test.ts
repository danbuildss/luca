// Integration: asking Luca about ACCUM creator fees in chat. The reply is Luca's fixed
// wording from the database, never the model's figures; Bankr's numbers are "reported
// by Bankr", claims are "verified on-chain", and a mismatch or a failed read is said
// plainly. Real Postgres; the model and Bankr are scripted.
import { it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => { process.env.AGENT_MODEL = 'gpt-4o'; });
let responses: unknown[] = [];
vi.mock('openai', () => ({
  default: class { chat = { completions: { create: () => Promise.resolve(responses.shift()) } }; },
}));
vi.mock('../../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<{ config: Record<string, unknown> }>();
  return { ...orig, config: { ...orig.config, OPENAI_API_KEY: 'test' } };
});
vi.mock('../../src/agent/system.js', () => ({ buildSystemPrompt: vi.fn(() => Promise.resolve('system')) }));
vi.mock('../../src/ingestion/price.js', () => ({
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.0005 })),
  enrichUsdValue: vi.fn(),
}));

import { describeDb, useIntegrationDb, insertUser, insertWallet, insertWatchJob, insertEvent, sql, type WalletFx } from './helpers/db.js';
import { ACCUM, ACCUM_RESPONSE } from '../fees/fixtures.js';
import { parseTokenFees, BankrUnavailable } from '../../src/fees/bankr.js';
import { addFeeSource, readDueFeeSources, allActiveSources } from '../../src/fees/sources.js';
import { checkFeeClaims } from '../../src/fees/claims.js';
import { NO_FEE_SOURCES } from '../../src/fees/report.js';
import { runAgent } from '../../src/agent/run.js';
import type { TxReceipt } from '../../src/ingestion/alchemy.js';

const LUCA_WALLET = ACCUM_RESPONSE.address;
const FEES = ACCUM_RESPONSE.tokens[0].feesContract;

function say(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}
function calls(name: string, args: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}
const bankr = (claimed = { token0: '0.000000', token1: '0.000000', count: 0 }) => (token: string) =>
  Promise.resolve(parseTokenFees({ ...ACCUM_RESPONSE, tokens: [{ ...ACCUM_RESPONSE.tokens[0], claimed }] }, token));
// Times depend on when the test runs; everything else is exact
const at = (text: string): string => text.replace(/[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} [A-Z]{2,5}/g, 'TIME');

async function setup(): Promise<{ userId: string; wallet: WalletFx }> {
  const user = await insertUser({ timezone: 'UTC' });
  const wallet = await insertWallet({ userId: user.id, address: LUCA_WALLET });
  await insertWatchJob({ userId: user.id, walletId: wallet.id, lastSyncedAt: '5 minutes' });
  const added = await addFeeSource({ walletAddress: LUCA_WALLET, token: ACCUM }, bankr());
  if (!added.ok) throw new Error(added.error);
  await sql(
    `INSERT INTO balance_snapshots (wallet_id, user_id, asset, balance, snapshot_at) VALUES ($1, $2, 'BNKR', 5000, NOW() - INTERVAL '10 minutes')`,
    [wallet.id, user.id],
  );
  return { userId: user.id, wallet };
}

const ask = (userId: string, text: string) => runAgent({ userId, userMessage: text, role: 'operator' });

describeDb('ACCUM creator fees in chat (integration)', () => {
  useIntegrationDb();
  beforeEach(() => { responses = []; });

  it("answers in Luca's own wording, whatever figures the model would have given", async () => {
    const { userId } = await setup();
    responses = [calls('get_creator_fees'), say('You earned 5 million BNKR this week!')];
    const r = await ask(userId, 'how are the ACCUM fees?');
    expect(at(r.text)).toBe([
      '*ACCUM creator fees*, paid in BNKR to 0xb540…6fdb',
      'ACCUM token 0x70ae…9ba3. I follow these fees; ACCUM itself is not a token I track.',
      '',
      'Reported by Bankr, TIME:',
      "- Claimable: 2,713,229.47 BNKR (about $1,356.61 at today's BNKR price)",
      '- Claimed so far: 0 BNKR in 0 claims',
      '',
      'Verified on-chain:',
      '- No claims into 0xb540…6fdb yet',
      "- Bankr's claimed figure matches the chain",
      '',
      'BNKR in 0xb540…6fdb: 5,000 ($2.50), as of TIME',
      'Staking and rewards: not active.',
    ].join('\n'));
    expect(r.text).not.toMatch(/earned|generated/i);
  });

  it('a claim on-chain, Bankr not caught up, and Bankr down: each said plainly', async () => {
    const { userId, wallet } = await setup();
    const ev = await insertEvent({ wallet, direction: 'in', counterparty: FEES, asset: 'BNKR', amount: '1000', usdValue: '0.6' });
    await sql(`UPDATE normalized_events SET raw_amount = 1000 * 10::numeric ^ 18 WHERE id = $1`, [ev.id]);
    await checkFeeClaims('key', await allActiveSources(), () => Promise.resolve({ status: 'success', raw: { logs: [] } } as unknown as TxReceipt));
    await sql(`UPDATE fee_source_readings SET read_at = NOW() - INTERVAL '3 hours'`);
    await readDueFeeSources(() => Promise.reject(new BankrUnavailable('Bankr did not answer within 10 seconds')));

    responses = [calls('get_creator_fees'), say('')];
    const r = at((await ask(userId, 'any ACCUM claims?')).text);
    expect(r).toContain('Reported by Bankr, TIME (over 2 hours old):');
    expect(r).toContain('- My latest read of Bankr failed, TIME: Bankr did not answer within 10 seconds. The figures above are from the last reading that worked.');
    expect(r).toContain(`- 1 claim, 1,000 BNKR ($0.60 when claimed); the last on TIME, [${ev.hash.slice(0, 6)}…${ev.hash.slice(-4)}](https://basescan.org/tx/${ev.hash})`);
    expect(r).toContain('- Bankr and the chain disagree: Bankr reports 0 BNKR claimed in 0 claims; I can verify 1,000 BNKR in 1');
  });

  it('the machine report only when asked for, as JSON with every source and time', async () => {
    const { userId } = await setup();
    // Asked in words: the model's format is ignored and the operator's words decide
    responses = [calls('get_creator_fees', {}), say('')];
    const r = await ask(userId, 'send me the machine report for the fees');
    expect(r.text).toMatch(/^Machine report \(JSON, read-only\):\n```\n[\s\S]+\n```$/);
    const json = JSON.parse(r.text.split('```\n')[1].replace(/\n```$/, '')) as { report: string; read_only: boolean; sources: Array<Record<string, unknown>> };
    expect(json).toMatchObject({ report: 'luca.creator_fees.v1', read_only: true });
    expect(json.sources[0]).toMatchObject({
      token: { address: ACCUM, symbol: 'ACCUM', tracked_by_luca: false },
      chain: 'base',
      fee_wallet: LUCA_WALLET,
      provider: 'bankr',
      pool_id: ACCUM_RESPONSE.tokens[0].poolId,
      fee_contract: FEES,
      fee_asset: 'BNKR',
      reported_by_bankr: { claimable: '2713229.471936', claimed: '0', claim_count: 0, stale: false },
      latest_read_error: null,
      verified_onchain: { claim_count: 0, claimed: '0', usd_when_claimed: null, last_claim: null },
      unproven_fee_transfers: 0,
      reconciliation: { status: 'match', claimed: '0', count: 0 },
      fee_wallet_balance: { asset: 'BNKR', amount: '5000' },
      staking: 'not_active',
      rewards: 'not_active',
    });

    // Not asked for: the summary, even if the model picks the machine format
    responses = [calls('get_creator_fees', { format: 'machine' }), say('')];
    expect((await ask(userId, 'how are the fees doing?')).text).toMatch(/^\*ACCUM creator fees\*/);
  });

  it('another operator gets nothing about these fees', async () => {
    await setup();
    const other = await insertUser();
    responses = [calls('get_creator_fees'), say('')];
    expect((await ask(other.id, 'how are the ACCUM fees?')).text).toBe(NO_FEE_SOURCES);
  });
});
