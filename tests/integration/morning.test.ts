// Integration: the morning message (week of Oct 4, PR 2). One message at 08:00, only when
// something happened or there is something new to ask; Mondays cover the week. Real
// Postgres; Telegram and live prices are stubbed.
import { it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/ingestion/price.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.0004245 })),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertClassifiedEvent, insertCounterpartyRule, sql, addr,
  type WalletFx,
} from './helpers/db.js';
import { deliverIfDue, localNow } from '../../src/briefs/scheduler.js';
import { refreshQuestionGroups, getQuestionsToSend } from '../../src/alerts/questions.js';
import { detectLargeMovements } from '../../src/alerts/detectors.js';
import type { Telegram } from 'telegraf';

const STAKE = '0x88470240ff0663faefa68b1d7621b472ddd9584a';
const FEES = '0x9982000000000000000000000000000000fdbb00';
const BNKR = '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b';

let sent: string[] = [];
const telegram = { sendMessage: vi.fn((_chat: number, text: string) => { sent.push(text); return Promise.resolve({ message_id: 70 + sent.length }); }) } as unknown as Pick<Telegram, 'sendMessage'>;

async function morning(userId: string, telegramId: number, type: 'daily' | 'weekly' = 'daily', now = new Date()): Promise<string | null> {
  const before = sent.length;
  const local = localNow('Europe/London', now);
  await deliverIfDue({ telegram, user: { userId, telegramId, timezone: 'Europe/London', briefTime: '00:00' }, local, briefTime: '00:00', type, now });
  return sent.length > before ? sent[sent.length - 1] : null;
}

async function balances(wallet: WalletFx, rows: Array<[string, number]>): Promise<void> {
  for (const [asset, balance] of rows) {
    await sql(`INSERT INTO balance_snapshots (wallet_id, user_id, asset, balance, snapshot_at) VALUES ($1, $2, $3, $4, NOW())`, [wallet.id, wallet.userId, asset, balance]);
  }
}

async function staked(wallet: WalletFx, amount: number, at = '5 hours'): Promise<void> {
  await sql(`INSERT INTO staking_contracts (address, is_staking, staking_token, reward_token, position_reader, reader_name)
             VALUES ($1, TRUE, $2, $2, '0x42623360', 'stakeOf(address)') ON CONFLICT (address) DO NOTHING`, [STAKE, BNKR]);
  const ev = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: STAKE, asset: 'BNKR', amount: 700000, usdValue: 297.15, label: 'staked', at });
  await sql(`INSERT INTO stake_checks (event_id, user_id, wallet_id, contract, verdict, amount_raw, block_number, evidence)
             VALUES ($1, $2, $3, $4, 'staked', 700000 * 10::numeric ^ 18, 2000, $5)`,
  [ev.id, wallet.userId, wallet.id, STAKE, JSON.stringify({ contract: STAKE, reader: 'stakeOf(address)', block: '2000', staked_before: '0', staked_after: (BigInt(amount) * 10n ** 18n).toString(), principal_seen: '0', reason: 'test' })]);
}

async function feeSource(wallet: WalletFx): Promise<string> {
  return (await sql<{ id: string }>(
    `INSERT INTO fee_sources (user_id, wallet_id, provider, token_address, token_symbol, pool_id, fee_contract, fee_asset, fee_token)
     VALUES ($1, $2, 'bankr', $3, 'ACCUM', $4, $5, 'BNKR', $6) RETURNING id`,
    [wallet.userId, wallet.id, '0x70ae' + '0'.repeat(32) + '9ba3', '0x' + 'f5'.repeat(32), FEES, BNKR],
  ))[0].id;
}

async function oct3(wallet: WalletFx): Promise<void> {
  await staked(wallet, 1_400_000);
  const swap = `0x${'7283'.padEnd(64, 'c')}`;
  const out = await insertClassifiedEvent({ wallet, direction: 'out', asset: 'BNKR', amount: 832016, usdValue: 349, label: 'swap', hash: swap, sourceKey: 'log:1', logIndex: 1, at: '4 hours' });
  const back = await insertClassifiedEvent({ wallet, direction: 'in', asset: 'USDC', amount: 349.12, usdValue: 349.12, label: 'swap', hash: swap, sourceKey: 'log:2', logIndex: 2, at: '4 hours' });
  await sql(`UPDATE classifications SET shape = 'swap' WHERE event_id = ANY($1::uuid[])`, [[out.id, back.id]]);
  const fee = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: FEES, asset: 'BNKR', amount: 10437, usdValue: 4.43, label: 'revenue', at: '3 hours' });
  await sql(`UPDATE classifications SET fee_source_id = $2 WHERE event_id = $1`, [fee.id, await feeSource(wallet)]);
  await balances(wallet, [['BNKR', 477566.441686], ['ETH', 0.00001393291233761]]);
}

const briefs = (userId: string) => sql<{ type: string; sent: boolean; skipped: boolean; holdings: unknown }>(
  `SELECT type, sent_at IS NOT NULL AS sent, skipped_at IS NOT NULL AS skipped, holdings FROM briefs WHERE user_id = $1 ORDER BY created_at`, [userId]);

describeDb('the morning message (integration)', () => {
  useIntegrationDb();
  beforeEach(() => { sent = []; });

  it('a quiet morning sends nothing, is marked done, and is not retried', async () => {
    const { user } = await seedUserWithWallet();
    expect(await morning(user.id, user.telegramId)).toBeNull();
    expect(await morning(user.id, user.telegramId)).toBeNull();
    expect(await briefs(user.id)).toEqual([expect.objectContaining({ type: 'daily', sent: false, skipped: true })]);
  });

  it('Oct 3, told the way it happened: a stake, a swap and creator fees, then holdings', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await oct3(wallet);
    expect(await morning(user.id, user.telegramId)).toBe([
      'Good morning. Since yesterday morning:',
      '- Staked 700,000 BNKR ($297.15).',
      '- Swapped 832,016 BNKR for 349.12 USDC.',
      '- ACCUM creator fees: 10,437 BNKR ($4.43).',
      '- You now have 1,400,000 BNKR staked.',
      '',
      'Holdings: $797.08 ($202.78 in your wallets, $594.30 staked).',
    ].join('\n'));
    // The first morning has nothing to compare with; its holdings are kept for the next one
    expect((await briefs(user.id))[0]).toMatchObject({ sent: true, holdings: { assets: { BNKR: { wallet: 477566.441686, staked: 1400000, price: 0.0004245 } } } });
  });

  it('the next morning says how much holdings changed and why: the price, not a loss', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await balances(wallet, [['BNKR', 477566.441686]]);
    await staked(wallet, 1_400_000, '3 days');
    const prev = { at: new Date(Date.now() - 24 * 3_600_000).toISOString(), assets: { BNKR: { wallet: 477566.441686, staked: 1_400_000, price: 0.00048239 } } };
    await sql(`INSERT INTO briefs (user_id, type, content, sent_at, holdings, created_at) VALUES ($1, 'daily', 'x', NOW() - INTERVAL '24 hours', $2, NOW() - INTERVAL '24 hours')`, [user.id, JSON.stringify(prev)]);
    await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', counterparty: addr(), amount: 25, usdValue: 25, at: '2 hours' });

    const text = (await morning(user.id, user.telegramId))!;
    expect(text).toMatch(/\nHoldings: \$797\.03 \(\$202\.73 in your wallets, \$594\.30 staked\), down \$108\.\d\d since yesterday, mostly BNKR's price \(down 12%\)\.$/);
  });

  it('nothing happened but there is something new to ask: just the question', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'Europe/London' });
    const ev = await insertClassifiedEvent({ wallet, direction: 'out', amount: 106.88, usdValue: 106.88, label: 'unknown', at: '3 days' });
    await refreshQuestionGroups(user.id);

    const text = (await morning(user.id, user.telegramId))!;
    expect(text.split('\n')).toEqual([
      'Good morning.',
      '',
      "One thing I couldn't place:",
      expect.stringMatching(new RegExp(`^106\\.88 USDC you sent to 0x[0-9a-f]{4}…[0-9a-f]{4}, [A-Z][a-z]{2} \\d{1,2} \\[${ev.hash.slice(0, 6)}…`)),
      'What was it for?',
    ]);
    // Asked once: the next morning has nothing to say
    expect(await getQuestionsToSend(user.id)).toEqual([]);
    expect(await sql(`SELECT asked_item, telegram_message_id FROM question_groups WHERE user_id = $1`, [user.id]))
      .toEqual([{ asked_item: null, telegram_message_id: expect.any(String) as unknown }]);
    await sql(`UPDATE briefs SET sent_at = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '1 day'`);
    expect(await morning(user.id, user.telegramId)).toBeNull();
    // In the conversation, so "it was a swap" has its context
    expect(await sql<{ content: string }>(`SELECT content FROM conversation_messages WHERE user_id = $1`, [user.id])).toEqual([{ content: text }]);
  });

  it('a transfer from last night that is asked about is not also told as a story line', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await insertClassifiedEvent({ wallet, direction: 'out', amount: 106.88, usdValue: 106.88, label: 'unknown', at: '2 hours' });
    await refreshQuestionGroups(user.id);
    const text = (await morning(user.id, user.telegramId))!;
    expect(text.split('\n').slice(0, 3)).toEqual(['Good morning.', '', "One thing I couldn't place:"]);
    expect(text.match(/106\.88/g)).toHaveLength(1);
  });

  it('three new transfers become one numbered list, never three messages', async () => {
    const { user, wallet } = await seedUserWithWallet();
    for (const [usd, at] of [[106.88, '3 days'], [56.65, '2 days'], [49.79, '2 days']] as const) {
      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), amount: usd, usdValue: usd, label: 'unknown', at });
    }
    await refreshQuestionGroups(user.id);

    const text = (await morning(user.id, user.telegramId))!;
    expect(sent).toHaveLength(1);
    const lines = text.split('\n');
    expect(lines.slice(0, 3)).toEqual(['Good morning.', '', "3 things I couldn't place:"]);
    expect(lines[3]).toMatch(/^1\. 106\.88 USDC you received from /);
    expect(lines[4]).toMatch(/^2\. 56\.65 USDC/);
    expect(lines[5]).toMatch(/^3\. 49\.79 USDC/);
    expect(lines[6]).toBe('Tell me what they were, like "1 was a swap, 2 was revenue".');
    expect((await sql<{ asked_item: number }>(`SELECT asked_item FROM question_groups WHERE user_id = $1 ORDER BY asked_item`, [user.id])).map((r) => r.asked_item)).toEqual([1, 2, 3]);
  });

  it('a large transfer nobody explained asks in its own alert, and the morning does not ask again', async () => {
    const { user, wallet } = await seedUserWithWallet({ materialityUsd: 50 });
    await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 106.88, usdValue: 106.88, label: 'unknown', at: '1 hour' });
    await refreshQuestionGroups(user.id);

    expect(await detectLargeMovements(user.id)).toBe(1);
    const [alert] = await sql<{ message: string }>(`SELECT message FROM alerts WHERE user_id = $1`, [user.id]);
    expect(alert.message.split('\n').slice(-2)).toEqual(['', 'What was it for?']);
    expect(await getQuestionsToSend(user.id)).toEqual([]);

    const text = (await morning(user.id, user.telegramId))!;
    expect(text).toContain('- Sent 106.88 USDC to 0x');
    expect(text).not.toMatch(/couldn't place|What was it for/);
  });

  it('a placed large transfer does not ask', async () => {
    const { user, wallet } = await seedUserWithWallet({ materialityUsd: 50 });
    await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 106.88, usdValue: 106.88, label: 'expense', at: '1 hour' });
    expect(await detectLargeMovements(user.id)).toBe(1);
    const [alert] = await sql<{ message: string }>(`SELECT message FROM alerts WHERE user_id = $1`, [user.id]);
    expect(alert.message).not.toContain('What was it for?');
  });

  it('names: the ACCUM fee contract, your own wallet, a name you gave; an address given as a name is ignored', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await sql(`UPDATE wallets SET label = 'Luca wallet' WHERE id = $1`, [wallet.id]);
    const other = (await sql<{ id: string; address: string }>(
      `INSERT INTO wallets (user_id, address, chain, label, active) VALUES ($1, $2, 'base', 'main', TRUE) RETURNING id, address`, [user.id, addr()]))[0];
    const vendor = addr();
    const looksLikeAddress = addr();
    await insertCounterpartyRule({ userId: user.id, address: vendor, label: 'expense', name: 'OpenAI', direction: 'out' });
    await insertCounterpartyRule({ userId: user.id, address: looksLikeAddress, label: 'expense', name: '0x8847…584a', direction: 'out' });
    await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', counterparty: vendor, amount: 45, usdValue: 45, at: '3 hours' });
    await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', counterparty: looksLikeAddress, amount: 12, usdValue: 12, at: '3 hours' });
    await insertClassifiedEvent({ wallet, direction: 'out', label: 'internal_transfer', counterparty: other.address, amount: 500, usdValue: 500, at: '2 hours' });
    await insertClassifiedEvent({ wallet, direction: 'in', label: 'internal_transfer', counterparty: other.address, amount: 80, usdValue: 80, at: '2 hours' });
    const fee = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: FEES, asset: 'BNKR', amount: 1000, usdValue: 0.42, label: 'revenue', at: '1 hour' });
    await sql(`UPDATE classifications SET fee_source_id = $2 WHERE event_id = $1`, [fee.id, await feeSource(wallet)]);

    const text = (await morning(user.id, user.telegramId))!;
    expect(text).toContain('- Paid 45 USDC to OpenAI.');
    expect(text).toMatch(new RegExp(`- Paid 12 USDC to ${looksLikeAddress.slice(0, 6)}…${looksLikeAddress.slice(-4)}\\.`));
    expect(text).toContain('- Moved 500 USDC to your main wallet.');
    expect(text).toContain('- Moved 80 USDC in from your main wallet.');
    expect(text).toContain('- ACCUM creator fees: 1,000 BNKR ($0.42).');
    expect(text).not.toContain('0x8847');
  });

  it('Monday: the week in one message; a quiet week is one line', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const vendor = addr();
    await insertCounterpartyRule({ userId: user.id, address: vendor, label: 'expense', name: 'OpenAI', direction: 'out' });
    await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', counterparty: vendor, amount: 45, usdValue: 45, at: '3 days' });
    const fee = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: FEES, asset: 'BNKR', amount: 2789063, usdValue: 1175.57, label: 'revenue', at: '5 days' });
    await sql(`UPDATE classifications SET fee_source_id = $2 WHERE event_id = $1`, [fee.id, await feeSource(wallet)]);
    await staked(wallet, 1_400_000, '6 days');
    await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), amount: 4, usdValue: 4, label: 'unknown', at: '2 days' });
    await refreshQuestionGroups(user.id);

    const text = (await morning(user.id, user.telegramId, 'weekly'))!;
    expect(text.split('\n')).toEqual([
      'Good morning. Your week:',
      '- Came in: $1,175.57 (ACCUM creator fees $1,175.57).',
      '- Paid out: $45.00 (OpenAI $45.00).',
      '- Staked 700,000 BNKR.',
      '- Not placed yet: 1 transfer ($4.00).',
      '',
      'Holdings: $594.30 (all staked).',
      '',
      "Plus 1 small transfer under $10.00 ($4.00 in total) I haven't asked about. Tell me if you want to go through it.",
    ]);

    const quiet = await seedUserWithWallet();
    await balances(quiet.wallet, [['USDC', 120]]);
    expect(await morning(quiet.user.id, quiet.user.telegramId, 'weekly')).toBe('Good morning. Quiet week: nothing moved in your wallets. Holdings: $120.00.');
  });
});
