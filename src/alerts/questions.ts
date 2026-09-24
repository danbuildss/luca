import { pool, query } from '../db.js';
import { logger } from '../logger.js';
import { usdValueSql } from '../ingestion/assets.js';
import type { ClassificationLabel } from '../types/index.js';
import { applyCorrection, type RuleOutcome } from '../corrections/handler.js';
import { relabelEvents } from '../corrections/store.js';

// Unknown transfers are asked about in groups: one question per address, direction and
// token ("4 outgoing USDC payments to 0xabc…, $1,240 total"), answered with one tap.
//   - Groups under PING_MIN_USD (and fully priced) never ping; the daily brief lists them.
//   - At most MAX_PINGS_PER_DAY questions per operator in any 24 hours.
//   - A skipped group comes back after REASK_AFTER_DAYS, or sooner if its total doubles.
//   - A group answered in chat instead closes by itself.
export const PING_MIN_USD = 10;
export const MAX_PINGS_PER_DAY = 3;
export const REASK_AFTER_DAYS = 30;

const USD = usdValueSql('ne');
const COUNTERPARTY = `LOWER(CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END)`;
const ASSET_KEY = `COALESCE(LOWER(ne.token_address), 'eth')`;
// Unknown transfers that need the operator (not retryable failures, not gas)
const OPEN_UNKNOWN = `ne.supported IS TRUE AND ne.source_key <> 'gas'
  AND c.label = 'unknown' AND c.source IS DISTINCT FROM 'failure'`;

// The group's current total has at least doubled since it was last asked or skipped.
const DOUBLED = (g: string): string => `(
  (${g}.asked_total_usd > 0 AND ${g}.total_usd >= 2 * ${g}.asked_total_usd)
  OR (COALESCE(${g}.asked_total_usd, 0) = 0 AND ${g}.asked_count > 0 AND ${g}.event_count >= 2 * ${g}.asked_count)
)`;

type GroupStats = {
  counterparty_address: string;
  direction: 'in' | 'out';
  asset_key: string;
  asset: string | null;
  event_count: number;
  total_usd: string;
  unpriced_count: number;
  first_at: Date;
  last_at: Date;
};

// Brings every group in line with the operator's current unknown transfers.
export async function refreshQuestionGroups(userId: string): Promise<void> {
  const stats = await query<GroupStats>(
    `SELECT ${COUNTERPARTY} AS counterparty_address, ne.direction, ${ASSET_KEY} AS asset_key,
            MAX(ne.asset) AS asset, COUNT(*)::int AS event_count,
            COALESCE(SUM(${USD}), 0)::text AS total_usd,
            (COUNT(*) FILTER (WHERE ${USD} IS NULL))::int AS unpriced_count,
            MIN(ne.block_time) AS first_at, MAX(ne.block_time) AS last_at
     FROM normalized_events ne
     JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1 AND ${OPEN_UNKNOWN}
       AND ${COUNTERPARTY} IS NOT NULL
     GROUP BY 1, 2, 3`,
    [userId],
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const g of stats.rows) {
      await client.query(
        `INSERT INTO question_groups
           (user_id, counterparty_address, direction, asset_key, asset, event_count, total_usd,
            unpriced_count, first_at, last_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, counterparty_address, direction, asset_key) DO UPDATE
           SET asset = EXCLUDED.asset, event_count = EXCLUDED.event_count, total_usd = EXCLUDED.total_usd,
               unpriced_count = EXCLUDED.unpriced_count, first_at = EXCLUDED.first_at,
               last_at = EXCLUDED.last_at, updated_at = NOW()`,
        [userId, g.counterparty_address, g.direction, g.asset_key, g.asset, g.event_count, g.total_usd,
          g.unpriced_count, g.first_at, g.last_at],
      );
    }
    // Groups with no unknown transfers left
    const keys = stats.rows.map((g) => `${g.counterparty_address}|${g.direction}|${g.asset_key}`);
    await client.query(
      `UPDATE question_groups SET event_count = 0, total_usd = 0, unpriced_count = 0, updated_at = NOW()
       WHERE user_id = $1 AND event_count > 0
         AND NOT (counterparty_address || '|' || direction || '|' || asset_key = ANY($2::text[]))`,
      [userId, keys],
    );
    // Answered in chat (or by a rule) instead of the buttons
    await client.query(
      `UPDATE question_groups SET status = 'labeled', resolved_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND status = 'open' AND event_count = 0`,
      [userId],
    );
    // New unknown transfers after an answer: a new question
    await client.query(
      `UPDATE question_groups
       SET status = 'open', sent_at = NULL, telegram_message_id = NULL, asked_total_usd = NULL,
           asked_count = NULL, resolved_at = NULL, updated_at = NOW()
       WHERE user_id = $1 AND status = 'labeled' AND event_count > 0`,
      [userId],
    );
    // Skipped: back after a while, or once the amount at stake has doubled
    await client.query(
      `UPDATE question_groups qg
       SET status = 'open', sent_at = NULL, telegram_message_id = NULL, resolved_at = NULL, updated_at = NOW()
       WHERE qg.user_id = $1 AND qg.status = 'skipped' AND qg.event_count > 0
         AND (qg.resolved_at <= NOW() - ($2::int * INTERVAL '1 day') OR ${DOUBLED('qg')})`,
      [userId, REASK_AFTER_DAYS],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type QuestionToSend = {
  id: string;
  user_id: string;
  telegram_id: string;
  counterparty_address: string;
  direction: 'in' | 'out';
  asset: string | null;
  event_count: number;
  total_usd: string;
  unpriced_count: number;
  first_at: Date;
  last_at: Date;
  // The single transfer, when the group has one
  amount: string | null;
};

// Questions that should go out now: big enough (or unpriced), not asked recently (or
// grown since), within each operator's daily limit, biggest first.
export async function getQuestionsToSend(): Promise<QuestionToSend[]> {
  const res = await query<QuestionToSend>(
    `WITH recent AS (
       SELECT user_id, COUNT(*)::int AS n FROM question_groups
       WHERE sent_at >= NOW() - INTERVAL '24 hours' GROUP BY user_id
     ), eligible AS (
       SELECT qg.*, u.telegram_id::text AS telegram_id,
              ROW_NUMBER() OVER (PARTITION BY qg.user_id ORDER BY qg.total_usd DESC, qg.last_at DESC) AS rn
       FROM question_groups qg
       JOIN users u ON u.id = qg.user_id
       WHERE qg.status = 'open' AND qg.event_count > 0 AND u.telegram_id > 0
         AND (qg.total_usd >= $1 OR qg.unpriced_count > 0)
         AND (qg.sent_at IS NULL OR qg.sent_at <= NOW() - ($2::int * INTERVAL '1 day') OR ${DOUBLED('qg')})
     )
     SELECT e.id, e.user_id, e.telegram_id, e.counterparty_address, e.direction, e.asset,
            e.event_count, e.total_usd::text AS total_usd, e.unpriced_count, e.first_at, e.last_at,
            one.amount
     FROM eligible e
     LEFT JOIN recent r ON r.user_id = e.user_id
     LEFT JOIN LATERAL (
       SELECT ne.amount::text AS amount
       FROM normalized_events ne
       JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE e.event_count = 1 AND ne.user_id = e.user_id AND ${OPEN_UNKNOWN}
         AND ${COUNTERPARTY} = e.counterparty_address AND ne.direction = e.direction
         AND ${ASSET_KEY} = e.asset_key
       LIMIT 1
     ) one ON TRUE
     WHERE e.rn <= $3 - COALESCE(r.n, 0)
     ORDER BY e.user_id, e.rn`,
    [PING_MIN_USD, REASK_AFTER_DAYS, MAX_PINGS_PER_DAY],
  );
  return res.rows;
}

export async function markQuestionSent(groupId: string, messageId: number): Promise<void> {
  await query(
    `UPDATE question_groups
     SET sent_at = NOW(), telegram_message_id = $2, asked_total_usd = total_usd, asked_count = event_count,
         updated_at = NOW()
     WHERE id = $1`,
    [groupId, messageId],
  );
}

export async function skipQuestionGroup(groupId: string, userId: string): Promise<void> {
  await query(
    `UPDATE question_groups
     SET status = 'skipped', resolved_at = NOW(), asked_total_usd = total_usd, asked_count = event_count,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [groupId, userId],
  );
}

export type GroupAnswer =
  | { ok: true; labeled: number; rule: RuleOutcome }
  | { ok: false; reason: 'not_found' | 'nothing_open' };

// One tap labels the whole group with the operator's answer; the latest transfer is recorded
// as the correction and teaches the rule for the address.
export async function labelQuestionGroup(
  groupId: string,
  userId: string,
  label: ClassificationLabel,
): Promise<GroupAnswer> {
  const group = await query<{ counterparty_address: string; direction: 'in' | 'out'; asset_key: string }>(
    `SELECT counterparty_address, direction, asset_key FROM question_groups WHERE id = $1 AND user_id = $2`,
    [groupId, userId],
  );
  const g = group.rows[0];
  if (!g) return { ok: false, reason: 'not_found' };

  const events = await query<{ id: string }>(
    `SELECT ne.id FROM normalized_events ne
     JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1 AND ${OPEN_UNKNOWN}
       AND ${COUNTERPARTY} = $2 AND ne.direction = $3 AND ${ASSET_KEY} = $4
     ORDER BY ne.block_time DESC`,
    [userId, g.counterparty_address, g.direction, g.asset_key],
  );
  if (events.rows.length === 0) {
    await query(
      `UPDATE question_groups SET status = 'labeled', resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [groupId],
    );
    return { ok: false, reason: 'nothing_open' };
  }

  // The rest first, as the operator's own labels, so the rule learned below leaves them be
  const [latest, ...rest] = events.rows.map((r) => r.id);
  const others = await relabelEvents(userId, rest, {
    label,
    confidence: 1.0,
    method: 'counterparty',
    evidence: 'User correction: answer to a grouped question',
    shape: 'single',
    rule_id: null,
    source: 'user',
  });
  const result = await applyCorrection({ userId, eventId: latest, newLabel: label, reason: 'Answer to a grouped question' });
  await query(
    `UPDATE question_groups SET status = 'labeled', resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [groupId],
  );
  logger.info({ userId, groupId, label, labeled: 1 + others }, 'Question group answered');
  return { ok: true, labeled: 1 + others, rule: result.rule };
}

export type OpenUnknowns = { count: number; small_count: number; small_usd: number };

// All unknown transfers still waiting on the operator, and how many of them are too small
// to ping about (they are listed in the brief instead).
export async function getOpenUnknowns(userId: string): Promise<OpenUnknowns> {
  const res = await query<{ count: number; small_count: number; small_usd: string | null }>(
    `SELECT COALESCE(SUM(event_count), 0)::int AS count,
            COALESCE(SUM(event_count) FILTER (WHERE total_usd < $2 AND unpriced_count = 0), 0)::int AS small_count,
            SUM(total_usd) FILTER (WHERE total_usd < $2 AND unpriced_count = 0)::text AS small_usd
     FROM question_groups WHERE user_id = $1 AND status IN ('open', 'skipped') AND event_count > 0`,
    [userId, PING_MIN_USD],
  );
  const r = res.rows[0];
  return { count: r?.count ?? 0, small_count: r?.small_count ?? 0, small_usd: r?.small_usd ? parseFloat(r.small_usd) : 0 };
}
