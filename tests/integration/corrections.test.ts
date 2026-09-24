// Integration: src/corrections (applyCorrection + rule upsert) and direction-aware
// rule application in the real classification pipeline, against real Postgres.
// Only the LLM boundary is stubbed. See tests/integration/helpers/db.ts for how to run.
import { describe, it, expect, vi } from 'vitest';

// LLM boundary stub: every event that reaches the model "fails" transiently,
// so anything not caught by deterministic/counterparty rules becomes a failure placeholder.
vi.mock('../../src/classification/llm.js', () => ({
  classifyWithLlmDetailed: vi.fn((events: Array<{ id: string }>) => Promise.resolve({
    results: new Map(),
    failures: new Map(events.map((e) => [e.id, { countsAsAttempt: false, reason: 'llm stubbed' }])),
  })),
  classifyWithLlm: vi.fn(() => Promise.resolve(new Map())),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassification, sql,
} from './helpers/db.js';
import { applyCorrection, EventNotFoundError } from '../../src/corrections/handler.js';
import { getCounterpartyRules } from '../../src/classification/store.js';
import { classifyByCounterparty } from '../../src/classification/counterparty.js';
import { classifyPendingEvents } from '../../src/classification/engine.js';

// Mixed case on purpose: rules are stored lowercase
const CUSTOMER = '0x00000000000000000000000000000000000AbCdE';

async function active(eventId: string) {
  const rows = await sql<{ label: string; method: string; source: string | null }>(
    `SELECT label::text, method, source FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`,
    [eventId],
  );
  return rows;
}

describeDb('corrections (integration)', () => {
  useIntegrationDb();

  describe('applyCorrection', () => {
    it('supersedes the old classification, records the correction and a direction-scoped rule', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertEvent({ wallet, direction: 'in', counterparty: CUSTOMER, amount: 100 });
      const oldId = await insertClassification({ eventId: ev.id, userId: user.id, label: 'unknown', confidence: 0.3 });

      const res = await applyCorrection({
        userId: user.id, eventId: ev.id, newLabel: 'revenue', reason: 'customer', counterpartyName: 'Acme',
        failureReason: 'missing_counterparty',
      });
      expect(res.wasCorrection).toBe(true);

      expect(await active(ev.id)).toEqual([{ label: 'revenue', method: 'counterparty', source: 'user' }]);

      const corr = await sql<{
        type: string; old_label: string; new_label: string; classification_id: string;
        old_confidence: string; created_rule: boolean; counterparty_address: string; failure_reason: string;
      }>(
        `SELECT type, old_label::text, new_label::text, classification_id, old_confidence::text,
                created_rule, counterparty_address, failure_reason::text
         FROM corrections WHERE id = $1`,
        [res.correctionId],
      );
      expect(corr[0]).toMatchObject({
        type: 'tx', old_label: 'unknown', new_label: 'revenue', classification_id: oldId,
        created_rule: true, counterparty_address: CUSTOMER, failure_reason: 'missing_counterparty',
      });
      expect(parseFloat(corr[0].old_confidence)).toBeCloseTo(0.3);

      const rules = await getCounterpartyRules(user.id);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        address: CUSTOMER.toLowerCase(), label: 'revenue', name: 'Acme', direction: 'in',
      });
    });

    it('opposite-direction corrections for one counterparty produce two coexisting rules', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const inEv = await insertEvent({ wallet, direction: 'in', counterparty: CUSTOMER });
      const outEv = await insertEvent({ wallet, direction: 'out', counterparty: CUSTOMER });

      await applyCorrection({ userId: user.id, eventId: inEv.id, newLabel: 'revenue' });
      await applyCorrection({ userId: user.id, eventId: outEv.id, newLabel: 'refund' });

      const rules = (await getCounterpartyRules(user.id))
        .map((r) => ({ direction: r.direction, label: r.label }))
        .sort((a, b) => String(a.direction).localeCompare(String(b.direction)));
      expect(rules).toEqual([
        { direction: 'in', label: 'revenue' },
        { direction: 'out', label: 'refund' },
      ]);
    });

    it('a correction that contradicts a rule switches it off; the next answer teaches it again', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const inEv = await insertEvent({ wallet, direction: 'in', counterparty: CUSTOMER });

      await applyCorrection({ userId: user.id, eventId: inEv.id, newLabel: 'revenue' });
      const off = await applyCorrection({ userId: user.id, eventId: inEv.id, newLabel: 'x402_income' });
      expect(off.rule).toEqual({ kind: 'switched_off', sentBack: 0 });
      expect(await getCounterpartyRules(user.id)).toEqual([]);

      const again = await applyCorrection({ userId: user.id, eventId: inEv.id, newLabel: 'x402_income' });
      expect(again.rule).toEqual({ kind: 'learned', relabeled: 0 });
      const rules = await getCounterpartyRules(user.id);
      expect(rules.map((r) => [r.direction, r.label])).toEqual([['in', 'x402_income']]);
      // Still one row per address and direction
      const all = await sql(`SELECT 1 FROM counterparty_rules WHERE user_id = $1`, [user.id]);
      expect(all).toHaveLength(1);
    });

    it('throws EventNotFoundError for another user\'s event', async () => {
      const a = await seedUserWithWallet();
      const b = await seedUserWithWallet();
      const ev = await insertEvent({ wallet: a.wallet, direction: 'in' });
      await expect(applyCorrection({ userId: b.user.id, eventId: ev.id, newLabel: 'revenue' }))
        .rejects.toBeInstanceOf(EventNotFoundError);
    });
  });

  describe('rule direction', () => {
    it('a rule learned from an incoming correction does not apply to an outgoing event', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const paid = await insertEvent({ wallet, direction: 'in', counterparty: CUSTOMER, amount: 100 });
      await insertClassification({ eventId: paid.id, userId: user.id, label: 'unknown', confidence: 0.2 });
      await applyCorrection({ userId: user.id, eventId: paid.id, newLabel: 'revenue' });

      const rules = await getCounterpartyRules(user.id);
      const refundOut = await insertEvent({ wallet, direction: 'out', counterparty: CUSTOMER, amount: 25 });
      const paidAgain = await insertEvent({ wallet, direction: 'in', counterparty: CUSTOMER, amount: 50 });

      // Pure rule application with rules loaded from the DB
      const asUnclassified = (e: typeof refundOut) => ({
        id: e.id, user_id: e.userId, wallet_id: e.walletId, hash: e.hash, log_index: null,
        block_time: new Date(), from_address: e.from, to_address: e.to, asset: 'USDC', amount: 1, direction: e.direction,
      });
      expect(classifyByCounterparty(asUnclassified(refundOut), rules)).toBeNull();
      expect(classifyByCounterparty(asUnclassified(paidAgain), rules)?.label).toBe('revenue');

      // Full pipeline: real DB reads/writes, LLM stubbed
      await classifyPendingEvents(user.id);

      expect(await active(paidAgain.id)).toEqual([{ label: 'revenue', method: 'counterparty', source: null }]);
      // Outgoing event fell through to the (stubbed, failing) LLM → retryable placeholder, not 'revenue'
      expect(await active(refundOut.id)).toEqual([{ label: 'unknown', method: 'model', source: 'failure' }]);
      // The user's correction is untouched
      expect(await active(paid.id)).toEqual([{ label: 'revenue', method: 'counterparty', source: 'user' }]);
    });
  });
});
