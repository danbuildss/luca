// Integration: src/ops/db.ts quality/correction queries and the migration-013
// quality_weekly_trend view, against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { describe, it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassification,
  insertClassifiedEvent, insertCorrection, dbTime, sql,
} from './helpers/db.js';
import { applyCorrection } from '../../src/corrections/handler.js';
import { getOpsOperatorDetail, getOpsQuality } from '../../src/ops/db.js';

// Fixed points inside whole weeks (DATE_TRUNC('week') = Monday 00:00 in the DB session TZ)
async function weekPoints() {
  const thisWeek = await dbTime(`DATE_TRUNC('week', NOW())`);
  const lastWeek = await dbTime(`DATE_TRUNC('week', NOW()) - INTERVAL '4 days'`);   // Thu of W-1
  const twoWeeksAgo = await dbTime(`DATE_TRUNC('week', NOW()) - INTERVAL '11 days'`); // Thu of W-2
  return { thisWeek, lastWeek, twoWeeksAgo };
}

describeDb('ops quality (integration)', () => {
  useIntegrationDb();

  describe('getOpsOperatorDetail / getOpsQuality correction counts', () => {
    it('correction counts are non-zero after a correction', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertEvent({ wallet, direction: 'in' });
      await insertClassification({ eventId: ev.id, userId: user.id, label: 'expense', confidence: 0.95 });
      await insertClassifiedEvent({ wallet, direction: 'out', label: 'unknown', confidence: 0.2 });

      await applyCorrection({ userId: user.id, eventId: ev.id, newLabel: 'revenue' });

      const detail = await getOpsOperatorDetail(user.id);
      expect(detail.quality.total_classified).toBe(2);
      expect(detail.quality.unknown_count).toBe(1);
      expect(detail.quality.correction_count).toBe(1);
      expect(detail.quality.high_confidence_errors).toBe(1); // old_confidence 0.95 > 0.8
      expect(detail.correction_count_30d).toBe(1);

      const q = await getOpsQuality();
      expect(q.total_classified).toBe(2);
      expect(q.correction_count).toBe(1);
      expect(q.correction_pct).toBeCloseTo(50);
      expect(q.high_confidence_errors).toBe(1);
      // The wrong (superseded) classification's method is counted as an error
      const model = q.method_breakdown.find((m) => m.method === 'model');
      expect(model?.error_count).toBe(1);
    });

    it('operator detail only counts the requested user\'s corrections', async () => {
      const a = await seedUserWithWallet();
      const b = await seedUserWithWallet();
      const evA = await insertClassifiedEvent({ wallet: a.wallet, direction: 'in', label: 'expense' });
      await insertClassifiedEvent({ wallet: b.wallet, direction: 'in', label: 'expense' });
      await applyCorrection({ userId: a.user.id, eventId: evA.id, newLabel: 'revenue' });

      expect((await getOpsOperatorDetail(a.user.id)).quality.correction_count).toBe(1);
      expect((await getOpsOperatorDetail(b.user.id)).quality.correction_count).toBe(0);
    });
  });

  describe('getOpsQuality weekly trend', () => {
    it('returns one row per week across users, with rates from summed counts', async () => {
      const { lastWeek, twoWeeksAgo } = await weekPoints();
      const a = await seedUserWithWallet();
      const b = await seedUserWithWallet();

      // W-1: 3 classified (A: 2, B: 1), 1 corrected event (corrected twice)
      const corrected = await insertClassifiedEvent({ wallet: a.wallet, direction: 'in', label: 'expense', at: lastWeek });
      await insertClassifiedEvent({ wallet: a.wallet, direction: 'in', label: 'revenue', at: lastWeek });
      await insertClassifiedEvent({ wallet: b.wallet, direction: 'out', label: 'expense', at: lastWeek });
      await applyCorrection({ userId: a.user.id, eventId: corrected.id, newLabel: 'revenue' });
      await applyCorrection({ userId: a.user.id, eventId: corrected.id, newLabel: 'x402_income' });

      // W-2: 2 classified (A: 1, B: 1 unknown)
      await insertClassifiedEvent({ wallet: a.wallet, direction: 'in', label: 'revenue', at: twoWeeksAgo });
      await insertClassifiedEvent({ wallet: b.wallet, direction: 'in', label: 'unknown', at: twoWeeksAgo });

      const { weekly_trend } = await getOpsQuality();
      expect(weekly_trend).toHaveLength(2);

      const [w1, w2] = weekly_trend; // ORDER BY week_start DESC
      expect(new Date(w1.week_start).getTime()).toBeGreaterThan(new Date(w2.week_start).getTime());
      expect(w1.total_classified).toBe(3);
      expect(w1.correction_rate).toBeCloseTo(1 / 3);
      expect(w1.unknown_rate).toBe(0);
      expect(w2.total_classified).toBe(2);
      expect(w2.correction_rate).toBe(0);
      expect(w2.unknown_rate).toBeCloseTo(0.5);
    });
  });

  describe('quality_weekly_trend view (migration 013)', () => {
    it('counts each corrected event once, ignores counterparty-type corrections', async () => {
      const { lastWeek } = await weekPoints();
      const { user, wallet } = await seedUserWithWallet();

      const twice = await insertClassifiedEvent({ wallet, direction: 'in', label: 'expense', at: lastWeek });
      const untouched = await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', at: lastWeek });
      await insertClassifiedEvent({ wallet, direction: 'in', label: 'unknown', at: lastWeek });

      await applyCorrection({ userId: user.id, eventId: twice.id, newLabel: 'revenue' });
      await applyCorrection({ userId: user.id, eventId: twice.id, newLabel: 'refund' });
      // A counterparty-level correction referencing an event must not count as a tx correction
      await insertCorrection({
        userId: user.id, type: 'counterparty', eventId: untouched.id,
        counterpartyAddress: untouched.to, newLabel: 'expense',
      });

      const rows = await sql<{
        total_classified: string; unknown_count: string; correction_count: string; correction_rate: string;
      }>(
        `SELECT total_classified::text, unknown_count::text, correction_count::text, correction_rate::text
         FROM quality_weekly_trend WHERE user_id = $1`,
        [user.id],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].total_classified)).toBe(3);
      expect(Number(rows[0].unknown_count)).toBe(1);
      expect(Number(rows[0].correction_count)).toBe(1);
      expect(Number(rows[0].correction_rate)).toBeCloseTo(1 / 3);
    });

    it('correction_count is 0 when nothing was corrected', async () => {
      const { lastWeek } = await weekPoints();
      const { user, wallet } = await seedUserWithWallet();
      await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', at: lastWeek });

      const rows = await sql<{ correction_count: string }>(
        'SELECT correction_count::text FROM quality_weekly_trend WHERE user_id = $1', [user.id],
      );
      expect(rows.map((r) => Number(r.correction_count))).toEqual([0]);
    });
  });
});
