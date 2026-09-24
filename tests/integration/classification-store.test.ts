// Integration: src/classification/store.ts against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { describe, it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassification, sql,
} from './helpers/db.js';
import {
  getUnclassifiedEvents, saveManyClassifications, MAX_CLASSIFICATION_ATTEMPTS,
} from '../../src/classification/store.js';

async function activeRows(eventId: string) {
  return sql<{ id: string; label: string; source: string | null; attempts: number; method: string }>(
    `SELECT id, label::text, source, attempts, method FROM classifications
     WHERE event_id = $1 AND superseded_at IS NULL`,
    [eventId],
  );
}

async function allRows(eventId: string) {
  return sql<{ id: string }>('SELECT id FROM classifications WHERE event_id = $1', [eventId]);
}

describeDb('classification store (integration)', () => {
  useIntegrationDb();

  describe('getUnclassifiedEvents', () => {
    it('returns never-classified events and due retryable failures; never user-sourced or real ones', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const other = await seedUserWithWallet();

      const fresh = await insertEvent({ wallet, direction: 'in', at: '10 hours' });
      const dueFailure = await insertEvent({ wallet, direction: 'in', at: '20 hours' });
      const dueFailureId = await insertClassification({
        eventId: dueFailure.id, userId: user.id, label: 'unknown', confidence: 0, method: 'model',
        source: 'failure', attempts: 1, retryAfterSeconds: -60,
      });
      const nullRetry = await insertEvent({ wallet, direction: 'out', at: '30 hours' });
      await insertClassification({
        eventId: nullRetry.id, userId: user.id, label: 'unknown', confidence: 0, source: 'failure', attempts: 0,
      });

      // Not returned:
      const notYetDue = await insertEvent({ wallet, direction: 'in', at: '5 hours' });
      await insertClassification({
        eventId: notYetDue.id, userId: user.id, label: 'unknown', confidence: 0, source: 'failure',
        attempts: 1, retryAfterSeconds: 3600,
      });
      const exhausted = await insertEvent({ wallet, direction: 'in', at: '6 hours' });
      await insertClassification({
        eventId: exhausted.id, userId: user.id, label: 'unknown', confidence: 0, source: 'failure',
        attempts: MAX_CLASSIFICATION_ATTEMPTS, retryAfterSeconds: -60,
      });
      const userLabelled = await insertEvent({ wallet, direction: 'in', at: '7 hours' });
      await insertClassification({ eventId: userLabelled.id, userId: user.id, label: 'unknown', confidence: 1, source: 'user' });
      const modelUnknown = await insertEvent({ wallet, direction: 'in', at: '8 hours' });
      await insertClassification({ eventId: modelUnknown.id, userId: user.id, label: 'unknown', confidence: 0.4 });
      const classified = await insertEvent({ wallet, direction: 'in', at: '9 hours' });
      await insertClassification({ eventId: classified.id, userId: user.id, label: 'revenue' });
      // Superseded failure whose replacement is a real classification
      const replaced = await insertEvent({ wallet, direction: 'in', at: '11 hours' });
      await insertClassification({
        eventId: replaced.id, userId: user.id, label: 'unknown', source: 'failure', retryAfterSeconds: -60, superseded: true,
      });
      await insertClassification({ eventId: replaced.id, userId: user.id, label: 'expense' });
      await insertEvent({ wallet: other.wallet, direction: 'in' }); // other user's

      const events = await getUnclassifiedEvents(user.id);
      const ids = events.map((e) => e.id);

      expect(new Set(ids)).toEqual(new Set([fresh.id, dueFailure.id, nullRetry.id]));
      // Never-classified first
      expect(ids[0]).toBe(fresh.id);
      const byId = new Map(events.map((e) => [e.id, e]));
      expect(byId.get(fresh.id)?.active_classification_id).toBeNull();
      expect(byId.get(dueFailure.id)?.active_classification_id).toBe(dueFailureId);
      // Retries ordered by block_time ASC
      expect(ids.slice(1)).toEqual([nullRetry.id, dueFailure.id]);
    });
  });

  describe('saveManyClassifications', () => {
    it('never overwrites a user correction (source = user)', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertEvent({ wallet, direction: 'in' });
      const userCls = await insertClassification({
        eventId: ev.id, userId: user.id, label: 'revenue', confidence: 1, method: 'counterparty', source: 'user',
      });

      const written = await saveManyClassifications([
        { event_id: ev.id, user_id: user.id, label: 'expense', confidence: 0.99, method: 'model', evidence: 'llm' },
        {
          event_id: ev.id, user_id: user.id, label: 'expense', confidence: 0.99, method: 'model', evidence: 'llm',
          expected_active_id: userCls,
        },
        {
          event_id: ev.id, user_id: user.id, label: 'unknown', confidence: 0, method: 'model', evidence: 'fail',
          failure: { countsAsAttempt: true, reason: 'bad output' },
        },
      ]);

      expect(written).toBe(0);
      const active = await activeRows(ev.id);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ id: userCls, label: 'revenue', source: 'user' });
      expect(await allRows(ev.id)).toHaveLength(1);
    });

    it('replaces a failure placeholder when expected_active_id matches; skips when it changed', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertEvent({ wallet, direction: 'out' });
      const failureId = await insertClassification({
        eventId: ev.id, userId: user.id, label: 'unknown', confidence: 0, source: 'failure', attempts: 1, retryAfterSeconds: -1,
      });

      // Stale read (thought there was no active classification) → skipped
      expect(await saveManyClassifications([
        { event_id: ev.id, user_id: user.id, label: 'gas', confidence: 0.9, method: 'model', evidence: 'x', expected_active_id: null },
      ])).toBe(0);

      expect(await saveManyClassifications([
        { event_id: ev.id, user_id: user.id, label: 'expense', confidence: 0.9, method: 'model', evidence: 'x', expected_active_id: failureId },
      ])).toBe(1);

      const active = await activeRows(ev.id);
      expect(active).toHaveLength(1);
      expect(active[0].label).toBe('expense');
      expect(active[0].source).toBeNull();
      expect(active[0].id).not.toBe(failureId);
    });

    it('updates an existing failure placeholder in place (attempts++) instead of adding rows', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertEvent({ wallet, direction: 'in' });
      const failureId = await insertClassification({
        eventId: ev.id, userId: user.id, label: 'unknown', confidence: 0, source: 'failure', attempts: 2, retryAfterSeconds: -1,
      });

      expect(await saveManyClassifications([
        {
          event_id: ev.id, user_id: user.id, label: 'unknown', confidence: 0, method: 'model', evidence: 'x',
          failure: { countsAsAttempt: true, reason: 'parse error' }, expected_active_id: failureId,
        },
      ])).toBe(1);

      expect(await allRows(ev.id)).toHaveLength(1);
      const rows = await sql<{ attempts: number; evidence: string; future: boolean }>(
        `SELECT attempts, evidence, retry_after > NOW() AS future FROM classifications WHERE id = $1`, [failureId],
      );
      expect(rows[0]).toEqual({ attempts: 3, evidence: 'parse error', future: true });
    });

    it('writes a fresh classification for a never-classified event', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertEvent({ wallet, direction: 'in' });
      expect(await saveManyClassifications([
        { event_id: ev.id, user_id: user.id, label: 'revenue', confidence: 0.8, method: 'model', evidence: 'x', expected_active_id: null },
      ])).toBe(1);
      const active = await activeRows(ev.id);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ label: 'revenue', source: null, method: 'model' });
    });
  });
});
