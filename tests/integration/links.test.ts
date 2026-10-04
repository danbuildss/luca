// Integration: every place Luca names a transaction carries a tappable BaseScan link, so an
// operator can check the claim on chain: tool results the model answers from, alerts and
// questions Luca sends on its own. Links only ever point at the operator's own transactions.
import { it, expect, vi } from 'vitest';

vi.mock('../../src/ingestion/price.js', () => ({
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
  enrichUsdValue: vi.fn(),
}));

import { describeDb, useIntegrationDb, seedUserWithWallet, insertClassifiedEvent, sql, addr } from './helpers/db.js';
import { executeTool } from '../../src/agent/tools.js';
import { getOverview } from '../../src/books/overview.js';
import { detectLargeMovements } from '../../src/alerts/detectors.js';
import { refreshQuestionGroups, getQuestionsToSend } from '../../src/alerts/questions.js';
import { askItem } from '../../src/alerts/ask.js';
import { namesFor } from '../../src/books/names.js';

const link = (h: string): string => `[${h.slice(0, 6)}…${h.slice(-4)}](https://basescan.org/tx/${h})`;

type Row = { hash: string; link: string };

describeDb('BaseScan links (integration)', () => {
  useIntegrationDb();

  it('every transaction a tool returns carries its own link', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const unknown = await insertClassifiedEvent({ wallet, direction: 'in', amount: 13.71, usdValue: 13.71, label: 'unknown' });
    const revenue = await insertClassifiedEvent({ wallet, direction: 'in', amount: 49.44, usdValue: 49.44, label: 'revenue' });

    const recent = await executeTool(user.id, 'get_recent_activity', {}) as { transactions: Row[] };
    expect(recent.transactions).toHaveLength(2);
    for (const t of recent.transactions) expect(t.link).toBe(link(t.hash));

    const byLabel = await executeTool(user.id, 'get_recent_activity', { label: 'revenue' }) as { transactions: Row[] };
    expect(byLabel.transactions).toEqual([expect.objectContaining({ hash: revenue.hash, link: link(revenue.hash) })]);

    const open = await executeTool(user.id, 'get_unknown_transactions', {}) as { events: Row[] };
    expect(open.events).toEqual([expect.objectContaining({ hash: unknown.hash, link: link(unknown.hash) })]);

    const one = await executeTool(user.id, 'get_transaction', { event_id: unknown.hash }) as { event: Row };
    expect(one.event.link).toBe(link(unknown.hash));

    const corrected = await executeTool(user.id, 'apply_correction', { event_id: unknown.id, new_label: 'revenue' });
    expect(corrected).toMatchObject({ success: true, link: link(unknown.hash) });

    const o = await getOverview(user.id, 30);
    for (const e of o.needs_context.examples) expect(e.link).toBe(link(e.hash));
  });

  it('a first-time payee in the overview links to the payment', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const paid = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 620, usdValue: 620, label: 'expense', at: '1 day' });
    const o = await getOverview(user.id, 30);
    expect(o.first_time_payments).toEqual([expect.objectContaining({ hash: paid.hash, link: link(paid.hash) })]);
  });

  it("another operator's transaction is never found, so it is never linked", async () => {
    const alice = await seedUserWithWallet();
    const bob = await seedUserWithWallet();
    const hers = await insertClassifiedEvent({ wallet: alice.wallet, direction: 'in', amount: 900, usdValue: 900, label: 'unknown' });

    const forBob = await executeTool(bob.user.id, 'get_transaction', { event_id: hers.hash });
    expect(forBob).toEqual({ error: 'Transaction not found' });
    expect(JSON.stringify(await executeTool(bob.user.id, 'get_recent_activity', {}))).not.toContain(hers.hash);
    expect(JSON.stringify(await executeTool(bob.user.id, 'get_unknown_transactions', {}))).not.toContain(hers.hash);
  });

  it('a large-transfer alert links to the transaction', async () => {
    const { user, wallet } = await seedUserWithWallet({ materialityUsd: 50 });
    const big = await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', amount: 100, usdValue: 100, at: '1 hour' });
    expect(await detectLargeMovements(user.id)).toBe(1);
    const [alert] = await sql<{ message: string; evidence: { hash: string } }>(`SELECT message, evidence FROM alerts WHERE user_id = $1`, [user.id]);
    expect(alert.message.split('\n').at(-1)).toBe(`Transaction: ${link(big.hash)}`);
    expect(alert.evidence.hash).toBe(big.hash);
  });

  it('a question about one transfer links to it; a question about a group does not list them', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const single = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), amount: 500, usdValue: 500, label: 'unknown', at: '1 day' });
    const cp = addr();
    for (const at of ['3 days', '2 days']) {
      await insertClassifiedEvent({ wallet, direction: 'out', counterparty: cp, amount: 400, usdValue: 400, label: 'unknown', at });
    }
    await refreshQuestionGroups(user.id);
    const qs = (await getQuestionsToSend()).filter((q) => q.user_id === user.id);

    const one = qs.find((q) => q.event_count === 1)!;
    expect(one.hash).toBe(single.hash);
    const name = await namesFor(user.id);
    const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
    expect(askItem(one, name, day).endsWith(` ${link(single.hash)}`)).toBe(true);

    const group = qs.find((q) => q.event_count === 2)!;
    expect(group.hash).toBeNull();
    expect(askItem(group, name, day)).not.toContain('basescan.org');
  });
});
