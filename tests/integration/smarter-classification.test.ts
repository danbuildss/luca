// Integration: whole-transaction classification, label status, safe rules and grouped
// questions (PR 4), against real Postgres. See tests/integration/helpers/db.ts for how to run.
import { it, expect, vi, beforeEach, describe } from 'vitest';

// The AI: labels every transfer revenue unless a test says otherwise, and records what it saw
const llm = vi.hoisted(() => ({
  label: 'revenue',
  calls: [] as Array<{ ids: string[]; context: Map<string, unknown> }>,
}));
vi.mock('../../src/classification/llm.js', () => ({
  classifyWithLlmDetailed: vi.fn((events: Array<{ id: string }>, _userId: string, context: Map<string, unknown>) => {
    llm.calls.push({ ids: events.map((e) => e.id), context });
    return Promise.resolve({
      results: new Map(events.map((e) => [e.id, { label: llm.label, confidence: 0.7, method: 'model', evidence: 'stub' }])),
      failures: new Map(),
    });
  }),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassifiedEvent, sql, addr,
} from './helpers/db.js';
import { classifyPendingEvents } from '../../src/classification/engine.js';
import { getPnlSummary } from '../../src/books/query.js';
import { applyCorrection } from '../../src/corrections/handler.js';
import { getCounterpartyRules } from '../../src/classification/store.js';
import { getEventWithClassification } from '../../src/corrections/store.js';
import {
  refreshQuestionGroups, getQuestionsToSend, markQuestionSent, labelQuestionGroup, skipQuestionGroup,
  getOpenUnknowns,
} from '../../src/alerts/questions.js';
import { questionText } from '../../src/telegram/alerts.js';

const UNISWAP = '0x2626664c2603336e57b271c5c0b26f421741e481';

type Active = { label: string; status: string; method: string; shape: string | null; source: string | null };
async function active(eventId: string): Promise<Active> {
  const rows = await sql<Active>(
    `SELECT label::text, status, method, shape, source FROM classifications
     WHERE event_id = $1 AND superseded_at IS NULL`,
    [eventId],
  );
  return rows[0];
}

let hashSeq = 0;
function txHash(): string {
  hashSeq++;
  return `0x${hashSeq.toString(16).padStart(64, 'e')}`;
}

describeDb('smarter classification (integration)', () => {
  useIntegrationDb();
  beforeEach(() => {
    llm.label = 'revenue';
    llm.calls = [];
  });

  describe('whole transactions', () => {
    it('a USDC to BNKR swap is a conversion: no revenue, no expense, only its gas counts', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const hash = txHash();
      const pool = addr();
      const out = await insertEvent({ wallet, hash, direction: 'out', counterparty: UNISWAP, amount: 100, usdValue: 100, sourceKey: 'log:1' });
      const inn = await insertEvent({ wallet, hash, direction: 'in', counterparty: pool, asset: 'BNKR', amount: 25_000, usdValue: 100, sourceKey: 'log:2' });
      const fee = await insertEvent({ wallet, hash, direction: 'out', counterparty: null, asset: 'ETH', amount: 0.00001, usdValue: 0.04, sourceKey: 'gas' });

      await classifyPendingEvents(user.id);

      expect(await active(out.id)).toMatchObject({ label: 'swap', status: 'confirmed', shape: 'swap' });
      expect(await active(inn.id)).toMatchObject({ label: 'swap', status: 'confirmed', shape: 'swap' });
      expect(await active(fee.id)).toMatchObject({ label: 'gas', status: 'confirmed', shape: 'gas' });
      expect(llm.calls).toHaveLength(0);

      const pnl = await getPnlSummary(user.id, 30);
      expect(pnl).toMatchObject({ revenue_usdc: 0, expenses_usdc: 0, unknown_count: 0, unpriced_count: 0 });
      expect(pnl.gas_usdc).toBeCloseTo(0.04, 6);
    });

    it('an ETH to USDC swap is a conversion too', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const hash = txHash();
      const out = await insertEvent({ wallet, hash, direction: 'out', counterparty: UNISWAP, asset: 'ETH', amount: 0.05, usdValue: 200, sourceKey: 'external' });
      const inn = await insertEvent({ wallet, hash, direction: 'in', asset: 'USDC', amount: 200, usdValue: 200, sourceKey: 'log:4' });
      await classifyPendingEvents(user.id);
      expect((await active(out.id)).label).toBe('swap');
      expect((await active(inn.id)).label).toBe('swap');
      const pnl = await getPnlSummary(user.id, 30);
      expect(pnl.revenue_usdc).toBe(0);
      expect(pnl.expenses_usdc).toBe(0);
    });

    it('a complex transaction is left unknown for the operator, never sent to the AI', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const hash = txHash();
      await insertEvent({ wallet, hash, direction: 'out', asset: 'MEME', tokenAddress: addr(), supported: false, amount: 5_000, sourceKey: 'log:1' });
      const eth = await insertEvent({ wallet, hash, direction: 'in', asset: 'ETH', amount: 0.3, usdValue: 1_200, sourceKey: 'internal:0' });
      await classifyPendingEvents(user.id);
      expect(await active(eth.id)).toMatchObject({ label: 'unknown', status: 'unknown', shape: 'complex', method: 'deterministic' });
      expect(llm.calls).toHaveLength(0);
    });

    it('a movement that arrives later turns an earlier guess into a swap', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const hash = txHash();
      const out = await insertEvent({ wallet, hash, direction: 'out', counterparty: UNISWAP, amount: 50, usdValue: 50, sourceKey: 'log:1' });
      llm.label = 'expense';
      await classifyPendingEvents(user.id);
      expect(await active(out.id)).toMatchObject({ label: 'expense', status: 'provisional', shape: 'single' });

      const inn = await insertEvent({ wallet, hash, direction: 'in', asset: 'BNKR', amount: 12_000, usdValue: 50, sourceKey: 'log:2' });
      await classifyPendingEvents(user.id);
      expect((await active(out.id)).label).toBe('swap');
      expect((await active(inn.id)).label).toBe('swap');
    });

    it('the AI sees the rest of the transaction and the address history, and its labels are provisional', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const customer = addr();
      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: customer, label: 'revenue', method: 'model', amount: 20, usdValue: 20, at: '3 days' });
      const hash = txHash();
      const pay = await insertEvent({ wallet, hash, direction: 'in', counterparty: customer, amount: 300, usdValue: 300, sourceKey: 'log:1' });
      await insertEvent({ wallet, hash, direction: 'out', counterparty: null, asset: 'ETH', amount: 0.00001, usdValue: 0.04, sourceKey: 'gas' });

      await classifyPendingEvents(user.id);

      expect(await active(pay.id)).toMatchObject({ label: 'revenue', status: 'provisional', shape: 'single' });
      const ctx = llm.calls.flatMap((c) => [...c.context.entries()]).find(([id]) => id === pay.id)?.[1];
      expect(ctx).toEqual({
        same_transaction: [{ kind: 'network_fee', direction: 'out', asset: 'ETH', amount: 0.00001 }],
        counterparty_history: { count: 1, labels: { revenue: 1 } },
      });

      const pnl = await getPnlSummary(user.id, 30);
      expect(pnl.revenue_usdc).toBeCloseTo(320, 6);
      expect(pnl.revenue_provisional_usdc).toBeCloseTo(320, 6);
      expect(pnl.provisional_count).toBe(2);
    });
  });

  describe('one-time re-check of labels written before this change', () => {
    it('fixes swaps, keeps other AI labels as provisional, and re-asks labels the AI may no longer choose', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const hash = txHash();
      const swapOut = await insertClassifiedEvent({ wallet, hash, direction: 'out', counterparty: UNISWAP, amount: 10, usdValue: 10, sourceKey: 'log:1', label: 'expense' });
      const swapIn = await insertClassifiedEvent({ wallet, hash, direction: 'in', asset: 'BNKR', amount: 2_000, usdValue: 10, sourceKey: 'log:2', label: 'revenue' });
      const kept = await insertClassifiedEvent({ wallet, direction: 'in', amount: 40, usdValue: 40, label: 'revenue' });
      const wrongGas = await insertClassifiedEvent({ wallet, direction: 'out', asset: 'ETH', amount: 0.001, usdValue: 4, label: 'gas' });
      const mine = await insertClassifiedEvent({ wallet, direction: 'out', amount: 5, usdValue: 5, label: 'expense', method: 'counterparty', source: 'user' });
      llm.label = 'expense';

      await classifyPendingEvents(user.id);

      expect((await active(swapOut.id)).label).toBe('swap');
      expect((await active(swapIn.id)).label).toBe('swap');
      expect(await active(kept.id)).toMatchObject({ label: 'revenue', status: 'provisional', shape: 'single' });
      expect(await active(wrongGas.id)).toMatchObject({ label: 'expense', status: 'provisional', shape: 'single' });
      expect(llm.calls.flatMap((c) => c.ids)).toEqual([wrongGas.id]);
      expect(await active(mine.id)).toMatchObject({ label: 'expense', source: 'user', shape: null });

      // Nothing left to re-check
      llm.calls = [];
      expect(await classifyPendingEvents(user.id)).toBe(0);
      expect(llm.calls).toHaveLength(0);
    });
  });

  describe('rules', () => {
    it('one answer labels earlier transfers with the address too, never ones the operator set', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const vendor = addr();
      const a = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, label: 'unknown', method: 'model' });
      const b = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, label: 'revenue', method: 'model' });
      const mine = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, label: 'refund', method: 'counterparty', source: 'user' });
      const incoming = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: vendor, label: 'unknown', method: 'model' });
      const latest = await insertEvent({ wallet, direction: 'out', counterparty: vendor });

      const result = await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'expense', counterpartyName: 'Hosting' });

      expect(result.rule).toEqual({ kind: 'learned', relabeled: 2 });
      expect(await active(a.id)).toMatchObject({ label: 'expense', status: 'confirmed', method: 'counterparty' });
      expect((await active(b.id)).label).toBe('expense');
      expect(await active(mine.id)).toMatchObject({ label: 'refund', source: 'user' });
      expect((await active(incoming.id)).label).toBe('unknown');

      const why = await getEventWithClassification(a.id, user.id);
      expect(why).toMatchObject({ status: 'confirmed', set_by_operator: false, rule: { label: 'expense', name: 'Hosting', active: true } });
    });

    it('never learns a rule from an exchange contract', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertEvent({ wallet, direction: 'out', counterparty: UNISWAP });
      const result = await applyCorrection({ userId: user.id, eventId: ev.id, newLabel: 'expense' });
      expect(result.rule).toEqual({ kind: 'swap_venue' });
      expect(await getCounterpartyRules(user.id)).toEqual([]);
    });

    it('never learns a rule from an address seen in one of the operator\'s swaps', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const router = addr();
      const hash = txHash();
      await insertEvent({ wallet, hash, direction: 'out', counterparty: router, amount: 10, sourceKey: 'log:1' });
      await insertEvent({ wallet, hash, direction: 'in', asset: 'BNKR', amount: 900, sourceKey: 'log:2' });
      await classifyPendingEvents(user.id);

      const later = await insertEvent({ wallet, direction: 'out', counterparty: router });
      const result = await applyCorrection({ userId: user.id, eventId: later.id, newLabel: 'expense' });
      expect(result.rule).toEqual({ kind: 'swap_venue' });
    });

    it('a correction that contradicts a rule switches it off and sends its transfers back as one question', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const cp = addr();
      const first = await insertEvent({ wallet, direction: 'out', counterparty: cp, amount: 30, usdValue: 30 });
      await applyCorrection({ userId: user.id, eventId: first.id, newLabel: 'expense' });

      const x = await insertEvent({ wallet, direction: 'out', counterparty: cp, amount: 20, usdValue: 20 });
      const y = await insertEvent({ wallet, direction: 'out', counterparty: cp, amount: 25, usdValue: 25 });
      await classifyPendingEvents(user.id);
      expect(await active(x.id)).toMatchObject({ label: 'expense', method: 'counterparty', status: 'confirmed' });

      const result = await applyCorrection({ userId: user.id, eventId: x.id, newLabel: 'refund' });
      expect(result.rule).toEqual({ kind: 'switched_off', sentBack: 1 });
      expect(await active(y.id)).toMatchObject({ label: 'unknown', status: 'unknown' });
      expect(await active(first.id)).toMatchObject({ label: 'expense', source: 'user' });
      const rule = await sql<{ active: boolean }>(`SELECT active FROM counterparty_rules WHERE user_id = $1`, [user.id]);
      expect(rule).toEqual([{ active: false }]);

      await refreshQuestionGroups(user.id);
      const qs = (await getQuestionsToSend()).filter((q) => q.user_id === user.id);
      expect(qs).toHaveLength(1);
      expect(qs[0]).toMatchObject({ event_count: 1, total_usd: '25' });
    });
  });

  describe('grouped questions', () => {
    async function mine(userId: string) {
      await refreshQuestionGroups(userId);
      return (await getQuestionsToSend()).filter((q) => q.user_id === userId);
    }

    it('asks once about a group of similar unknown transfers, and one answer labels them all', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const cp = addr();
      const evs = [];
      for (const [usd, at] of [[400, '20 days'], [300, '10 days'], [340, '5 days'], [200, '1 day']] as const) {
        evs.push(await insertClassifiedEvent({ wallet, direction: 'out', counterparty: cp, amount: usd, usdValue: usd, at, label: 'unknown' }));
      }

      const qs = await mine(user.id);
      expect(qs).toHaveLength(1);
      expect(questionText(qs[0])).toMatch(/^4 outgoing USDC payments to `0x0+[0-9a-f]+…[0-9a-f]+`, \$1,240\.00 total, \w+ \d+ to \w+ \d+\./);

      const answer = await labelQuestionGroup(qs[0].id, user.id, 'expense');
      expect(answer).toMatchObject({ ok: true, labeled: 4, rule: { kind: 'learned' } });
      for (const e of evs) expect(await active(e.id)).toMatchObject({ label: 'expense', source: 'user' });

      // The next one from this address is labeled by the rule, with no question
      const next = await insertEvent({ wallet, direction: 'out', counterparty: cp, amount: 90, usdValue: 90 });
      await classifyPendingEvents(user.id);
      expect(await active(next.id)).toMatchObject({ label: 'expense', method: 'counterparty', status: 'confirmed' });
      expect(await mine(user.id)).toHaveLength(0);
    });

    it('small groups never ping; the brief counts them instead', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertClassifiedEvent({ wallet, direction: 'out', amount: 3, usdValue: 3, label: 'unknown' });
      await insertClassifiedEvent({ wallet, direction: 'in', amount: 4.5, usdValue: 4.5, label: 'unknown' });
      expect(await mine(user.id)).toHaveLength(0);
      expect(await getOpenUnknowns(user.id)).toEqual({ count: 2, small_count: 2, small_usd: 7.5 });
    });

    it('sends at most 3 questions a day, biggest first', async () => {
      const { user, wallet } = await seedUserWithWallet();
      for (const usd of [50, 500, 20, 900, 70]) {
        await insertClassifiedEvent({ wallet, direction: 'out', amount: usd, usdValue: usd, label: 'unknown' });
      }
      const first = await mine(user.id);
      expect(first.map((q) => Number(q.total_usd))).toEqual([900, 500, 70]);
      for (const [i, q] of first.entries()) await markQuestionSent(q.id, 1000 + i);
      expect(await mine(user.id)).toHaveLength(0);

      await sql(`UPDATE question_groups SET sent_at = NOW() - INTERVAL '25 hours' WHERE user_id = $1 AND sent_at IS NOT NULL`, [user.id]);
      expect((await mine(user.id)).map((q) => Number(q.total_usd))).toEqual([50, 20]);
    });

    it('a skipped group comes back when its total doubles, or after 30 days', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const cp = addr();
      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 100, usdValue: 100, label: 'unknown' });
      const [q] = await mine(user.id);
      await markQuestionSent(q.id, 1);
      await skipQuestionGroup(q.id, user.id);
      expect(await mine(user.id)).toHaveLength(0);

      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 60, usdValue: 60, label: 'unknown' });
      expect(await mine(user.id)).toHaveLength(0); // 160 < 2 × 100

      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 40, usdValue: 40, label: 'unknown' });
      const back = await mine(user.id);
      expect(back).toHaveLength(1);
      expect(back[0]).toMatchObject({ id: q.id, event_count: 3 });

      await markQuestionSent(q.id, 2);
      await skipQuestionGroup(q.id, user.id);
      expect(await mine(user.id)).toHaveLength(0);
      await sql(`UPDATE question_groups SET resolved_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [q.id]);
      expect(await mine(user.id)).toHaveLength(1);
    });

    it('a group answered in chat closes by itself', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertClassifiedEvent({ wallet, direction: 'in', amount: 80, usdValue: 80, label: 'unknown' });
      expect(await mine(user.id)).toHaveLength(1);
      await applyCorrection({ userId: user.id, eventId: ev.id, newLabel: 'revenue' });
      expect(await mine(user.id)).toHaveLength(0);
      const g = await sql<{ status: string }>(`SELECT status FROM question_groups WHERE user_id = $1`, [user.id]);
      expect(g).toEqual([{ status: 'labeled' }]);
    });
  });
});
