// Integration: a new wallet goes reading -> ready (or failed), from real state only
// (migration 028). Luca says it is reading, never answers as if the books were complete
// before they are, and messages the operator once when they are ready. Real Postgres;
// the model, prices and chain balance reads are scripted.
import { it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => { process.env.AGENT_MODEL = 'gpt-4o'; });
let responses: unknown[] = [];
vi.mock('openai', () => ({
  default: class { chat = { completions: { create: () => Promise.resolve(responses.shift()) } }; },
}));
vi.mock('../../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<{ config: Record<string, unknown> }>();
  return { ...orig, config: { ...orig.config, OPENAI_API_KEY: 'test', ALCHEMY_API_KEY: 'test' } };
});
vi.mock('../../src/agent/system.js', () => ({ buildSystemPrompt: vi.fn(() => Promise.resolve('system')) }));
vi.mock('../../src/ingestion/price.js', () => ({
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
  enrichUsdValue: vi.fn(),
}));
const chain = vi.hoisted(() => ({ fail: false, eth: 0.25, token: 40 }));
vi.mock('../../src/ingestion/alchemy.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEthBalance: vi.fn(() => (chain.fail ? Promise.reject(new Error('rpc down')) : Promise.resolve(chain.eth))),
  getErc20Balance: vi.fn(() => (chain.fail ? Promise.reject(new Error('rpc down')) : Promise.resolve(chain.token))),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertUser, insertEvent,
  insertClassification, sql, type WalletFx,
} from './helpers/db.js';
import { runAgent } from '../../src/agent/run.js';
import { executeTool } from '../../src/agent/tools.js';
import { walletReadiness } from '../../src/ledger/status.js';
import { notifyWalletReadiness, readyText, failedText, stillReadingText, ONLY_BASE } from '../../src/onboarding/notify.js';
import { WELCOME_MSG } from '../../src/telegram/access.js';

const NEW = '0x9a958557d906f10aca9ed0a8509cf9366059e511';

function say(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}
function calls(name: string, args: Record<string, unknown>) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}
const says = (userId: string, text: string) => runAgent({ userId, userMessage: text, role: 'operator' });

// The new operator from Sep 28: tracks NEW from chat
async function track(userId: string): Promise<{ done: string; wallet: WalletFx }> {
  responses = [calls('register_wallet', { address: NEW }), say('')];
  await says(userId, NEW);
  const done = (await says(userId, 'Yes')).text;
  const row = (await sql<{ id: string }>(`SELECT id FROM wallets WHERE address = $1 AND user_id = $2`, [NEW, userId]))[0];
  return { done, wallet: { id: row.id, userId, address: NEW } };
}
// What the worker records as it goes
const read = (walletId: string) => sql(`UPDATE watch_jobs SET last_block = 100, last_synced_at = NOW() WHERE wallet_id = $1`, [walletId]);
const checked = (walletId: string, status = 'complete') =>
  sql(`UPDATE watch_jobs SET last_reconciled_at = NOW(), ledger_status = $2 WHERE wallet_id = $1`, [walletId, status]);
const failedRun = (walletId: string, status = 'failed') => sql(`INSERT INTO sync_runs (wallet_id, status) VALUES ($1, $2)`, [walletId, status]);
const messages = (userId: string) => sql<{ type: string; message: string }>(
  `SELECT type, message FROM alerts WHERE user_id = $1 AND type IN ('wallet_ready', 'wallet_read_failed') ORDER BY created_at`, [userId],
);
const state = async (userId: string, walletId: string) => (await walletReadiness(userId)).find((w) => w.wallet_id === walletId)!;

async function newOperator() {
  const user = await insertUser();
  const { wallet } = await track(user.id);
  return { user, wallet };
}

describeDb('first-run experience: reading -> ready (integration)', () => {
  useIntegrationDb();
  beforeEach(() => { responses = []; chain.fail = false; chain.eth = 0.25; chain.token = 40; });

  it('1. a new wallet is reading straight after "yes"', async () => {
    const { user, wallet } = await newOperator();
    expect(await state(user.id, wallet.id)).toMatchObject({ state: 'reading', onboarded: false });
  });

  it('2. ready only when read in full, checked against Base, and every transfer labeled', async () => {
    const { user, wallet } = await newOperator();
    const ev = await insertEvent({ wallet, direction: 'in', asset: 'USDC', amount: 12, usdValue: 12 });

    // A partial read sets last_synced_at but never the cursor: still reading
    await sql(`UPDATE watch_jobs SET last_synced_at = NOW() WHERE wallet_id = $1`, [wallet.id]);
    expect((await state(user.id, wallet.id)).state).toBe('reading');
    await read(wallet.id);
    expect((await state(user.id, wallet.id)).state).toBe('reading');
    await checked(wallet.id);
    expect((await state(user.id, wallet.id)).state).toBe('reading'); // a transfer has no label yet
    expect(await notifyWalletReadiness(user.id)).toBe(0);

    await insertClassification({ eventId: ev.id, userId: user.id, label: 'revenue' });
    expect((await state(user.id, wallet.id)).state).toBe('ready');
    expect(await notifyWalletReadiness(user.id)).toBe(1);
  });

  it('3. while reading, answers that need complete books give no figures', async () => {
    const { user, wallet } = await newOperator();
    await insertClassification({ eventId: (await insertEvent({ wallet, direction: 'out', asset: 'USDC', amount: 5, usdValue: 5 })).id, userId: user.id, label: 'expense' });

    const reading = "I'm still reading 0x9a95…e511. I'll message you when your books are ready, then ask me again.";
    for (const tool of ['get_books_summary', 'get_recent_activity', 'get_overview', 'get_figure_breakdown', 'get_unknown_transactions', 'check_books_complete']) {
      const r = await executeTool(user.id, tool, { figure: 'expenses' });
      expect(r).toEqual({ books_ready: false, still_reading: [{ address: NEW, state: 'reading' }], reply: reading });
    }
    // "Are my books complete?" is answered in code, and starts no check
    expect((await says(user.id, 'are my books complete?')).text).toBe(reading);
    expect(await sql(`SELECT 1 FROM audit_runs WHERE user_id = $1`, [user.id])).toHaveLength(0);
  });

  it('3b. with another wallet ready, figures come back marked as not covering the new one', async () => {
    const { user } = await seedUserWithWallet();
    await track(user.id);
    const r = await executeTool(user.id, 'get_books_summary', {}) as { pnl: unknown; books_ready: boolean; note: string };
    expect(r.pnl).toBeDefined();
    expect(r.books_ready).toBe(false);
    expect(r.note).toContain(NEW);
  });

  it('4. reading -> ready sends exactly one ready message, from the books', async () => {
    const { user, wallet } = await newOperator();
    const a = await insertEvent({ wallet, direction: 'in', asset: 'USDC', amount: 12, usdValue: 12 });
    const b = await insertEvent({ wallet, direction: 'out', asset: 'USDC', amount: 5, usdValue: 5 });
    await insertClassification({ eventId: a.id, userId: user.id, label: 'revenue' });
    await insertClassification({ eventId: b.id, userId: user.id, label: 'unknown' });
    await read(wallet.id);
    await checked(wallet.id);

    await notifyWalletReadiness(user.id);
    await notifyWalletReadiness(user.id);
    expect(await messages(user.id)).toEqual([{
      type: 'wallet_ready',
      message: [
        'Your books for 0x9a95…e511 are ready.',
        'On Base: 0.25 ETH, 40 USDC and 40 BNKR.',
        'Last 30 days: 2 transactions. $12.00 in, $5.00 out.',
        "1 payment I couldn't place; I'll ask you about it.",
        'Ask me anything, like "how did this month go?"',
      ].join('\n'),
    }]);
    expect((await state(user.id, wallet.id)).onboarded).toBe(true);
    // Answers are no longer held back
    expect(await executeTool(user.id, 'get_books_summary', {})).not.toHaveProperty('books_ready');
  });

  it('5. a failed read says it is trying again, never ready; a later success says ready once', async () => {
    const { user, wallet } = await newOperator();
    await failedRun(wallet.id);
    await sql(`UPDATE watch_jobs SET status = 'error' WHERE wallet_id = $1`, [wallet.id]);
    expect((await state(user.id, wallet.id)).state).toBe('failed');
    await notifyWalletReadiness(user.id);
    await notifyWalletReadiness(user.id);
    expect(await messages(user.id)).toEqual([{ type: 'wallet_read_failed', message: failedText(NEW) }]);
    expect((await executeTool(user.id, 'get_recent_activity', {}) as { reply: string }).reply)
      .toBe("I couldn't finish reading 0x9a95…e511 yet. I'm trying again and will message you when your books are ready.");

    // A partial first read counts as a failed attempt too; then the retry succeeds
    await sql(`UPDATE watch_jobs SET status = 'active' WHERE wallet_id = $1`, [wallet.id]);
    await read(wallet.id);
    await checked(wallet.id, 'unknown');
    await notifyWalletReadiness(user.id);
    const sent = await messages(user.id);
    expect(sent.map((m) => m.type)).toEqual(['wallet_read_failed', 'wallet_ready']);
    expect(sent[1].message).toContain("I couldn't double-check them against Base yet.");
  });

  it('6. wallets already tracked get no onboarding messages and are never held back', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await insertEvent({ wallet, direction: 'in', asset: 'USDC', amount: 3, usdValue: 3 }); // not labeled yet
    expect(await notifyWalletReadiness(user.id)).toBe(0);
    expect(await messages(user.id)).toEqual([]);
    expect(await executeTool(user.id, 'get_recent_activity', {})).not.toHaveProperty('books_ready');
  });

  it('7. isolation: another operator\'s new wallet changes nothing here, and messages go to its owner only', async () => {
    const a = await seedUserWithWallet();
    const b = await newOperator();
    await read(b.wallet.id);
    await checked(b.wallet.id);

    expect(await executeTool(a.user.id, 'get_books_summary', {})).not.toHaveProperty('books_ready');
    expect(await notifyWalletReadiness(a.user.id)).toBe(0);
    expect(await notifyWalletReadiness(b.user.id)).toBe(1);
    expect(await messages(a.user.id)).toEqual([]);
    expect((await messages(b.user.id)).map((m) => m.type)).toEqual(['wallet_ready']);
  });

  it('8. Austin\'s exchange (Sep 28), replayed', async () => {
    const user = await insertUser();
    const { done, wallet } = await track(user.id);
    expect(done).toBe("Done. I'm reading 0x9a95…e511 on Base. I can already see 0.25 ETH, 40 USDC and 40 BNKR. I'll message you when your books are ready.");

    // "What is the current balance you see?" 15 seconds later: real balances, books not ready
    const cash = await executeTool(user.id, 'get_cash_position', {}) as {
      chain: string; total_usd: number | null; wallets: Array<{ books_ready: boolean; balances_read: boolean }>;
    };
    expect(cash.chain).toBe('Base');
    expect(cash.total_usd).toBeGreaterThan(0);
    expect(cash.wallets).toEqual([expect.objectContaining({ books_ready: false, balances_read: true })]);

    await read(wallet.id);
    await checked(wallet.id);
    await notifyWalletReadiness(user.id);
    expect((await messages(user.id))[0].message).toMatch(/^Your books for 0x9a95…e511 are ready\.\nOn Base: 0\.25 ETH, 40 USDC and 40 BNKR\./);
  });

  it('9. nothing on Base: says so, and that only Base is read', async () => {
    chain.eth = 0;
    chain.token = 0;
    const user = await insertUser();
    const { done, wallet } = await track(user.id);
    expect(done).toBe(`Done. I'm reading 0x9a95…e511 on Base. I don't see any ETH, USDC or BNKR on Base in it right now. ${ONLY_BASE} I'll message you when your books are ready.`);
    await read(wallet.id);
    await checked(wallet.id);
    await notifyWalletReadiness(user.id);
    expect((await messages(user.id))[0].message).toBe(
      `Your books for 0x9a95…e511 are ready. I don't see anything on Base for this wallet in the last 30 days. ${ONLY_BASE}\nAsk me anything, like "how did this month go?"`,
    );
  });

  it('10. a failed balance read never shows $0', async () => {
    chain.fail = true;
    const user = await insertUser();
    const { done } = await track(user.id);
    expect(done).toBe("Done. I'm reading 0x9a95…e511 on Base. I'll message you when your books are ready.");
    const cash = await executeTool(user.id, 'get_cash_position', {}) as { total_usd: number | null; note: string; wallets: Array<{ balances_read: boolean }> };
    expect(cash.total_usd).toBeNull();
    expect(cash.note).toMatch(/never \$0/);
    expect(cash.wallets[0].balances_read).toBe(false);
  });

  it('11. none of these messages use internal words', () => {
    const texts = [
      WELCOME_MSG,
      readyText({ address: NEW, ledger_status: 'incomplete', incomplete_since_at: new Date('2026-09-23T00:00:00Z') },
        [{ asset: 'ETH', balance: 1 }], { transactions: 3, received_usd: 1, sent_usd: 1, unpriced: 1, unplaced: 2 }),
      readyText({ address: NEW, ledger_status: 'unknown', incomplete_since_at: null }, [], { transactions: 0, received_usd: 0, sent_usd: 0, unpriced: 0, unplaced: 0 }),
      failedText(NEW),
      stillReadingText([{ address: NEW, state: 'reading' }]),
      stillReadingText([{ address: NEW, state: 'failed' }]),
    ];
    for (const t of texts) expect(t).not.toMatch(/\b(snapshot|sync|synced|syncing|tracked token|indexer|reconcil\w*|worker|rpc)\b/i);
    expect(WELCOME_MSG).toContain('I read ETH, USDC and BNKR on Base');
  });
});
