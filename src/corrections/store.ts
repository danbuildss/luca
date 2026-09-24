import { pool, query } from '../db.js';
import type { ClassificationLabel, TxShape } from '../types/index.js';
import { findCounterpartyRule } from '../classification/counterparty.js';
import type { CounterpartyRuleRow } from '../classification/types.js';
import type { FailureReason } from './handler.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A full transaction hash, or a shortened one like "0x619bde94…" (at least 8 hex digits)
const TX_HASH_PREFIX_RE = /^0x[0-9a-f]{8,64}$/i;

export type EventCandidate = { id: string; hash: string; direction: 'in' | 'out'; asset: string | null; amount: string | null };

export type EventRefResolution =
  | { status: 'found'; event: EventCandidate }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: EventCandidate[] };

// Resolves what a user or the agent calls a transaction (Luca's event UUID, or a full or
// shortened tx hash) to one of this user's supported events.
export async function resolveEventRef(userId: string, ref: string): Promise<EventRefResolution> {
  const cleaned = ref.trim().replace(/[.…]+$/u, '');
  let rows: EventCandidate[];
  if (UUID_RE.test(cleaned)) {
    rows = (await query<EventCandidate>(
      `SELECT id, hash, direction, asset, amount::text AS amount FROM normalized_events
       WHERE id = $1 AND user_id = $2 AND supported IS TRUE`,
      [cleaned, userId],
    )).rows;
  } else if (TX_HASH_PREFIX_RE.test(cleaned)) {
    rows = (await query<EventCandidate>(
      `SELECT id, hash, direction, asset, amount::text AS amount FROM normalized_events
       WHERE user_id = $1 AND supported IS TRUE AND LOWER(hash) LIKE $2
       ORDER BY block_time DESC
       LIMIT 5`,
      [userId, `${cleaned.toLowerCase()}%`],
    )).rows;
  } else {
    return { status: 'not_found' };
  }
  if (rows.length === 0) return { status: 'not_found' };
  if (rows.length > 1) return { status: 'ambiguous', candidates: rows };
  return { status: 'found', event: rows[0] };
}

export type EventWithClassification = {
  id: string;
  direction: 'in' | 'out';
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  current_label: ClassificationLabel | null;
  current_classification_id: string | null;
  current_confidence: number | null;
  // Why it carries this label: confirmed / provisional / unknown, how it was decided,
  // the evidence, and the learned rule if one made it
  status: 'confirmed' | 'provisional' | 'unknown' | null;
  method: string | null;
  set_by_operator: boolean;
  evidence: string | null;
  shape: TxShape | null;
  rule: { label: ClassificationLabel; name: string | null; active: boolean; learned_at: Date } | null;
};

export async function getEventWithClassification(
  eventId: string,
  userId: string,
): Promise<EventWithClassification | null> {
  if (!UUID_RE.test(eventId)) return null;
  const res = await query<EventWithClassification>(
    `SELECT ne.id, ne.direction, ne.from_address, ne.to_address, ne.asset, ne.amount,
            c.label AS current_label,
            c.id    AS current_classification_id,
            c.confidence AS current_confidence,
            c.status, c.method, COALESCE(c.source = 'user', FALSE) AS set_by_operator, c.evidence, c.shape,
            CASE WHEN r.id IS NULL THEN NULL
                 ELSE json_build_object('label', r.label, 'name', r.name, 'active', r.active, 'learned_at', r.created_at)
            END AS rule
     FROM normalized_events ne
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     LEFT JOIN counterparty_rules r ON r.id = c.rule_id AND r.user_id = ne.user_id
     WHERE ne.id = $1 AND ne.user_id = $2 AND ne.supported IS TRUE`,
    [eventId, userId],
  );
  return res.rows[0] ?? null;
}

// direction: the event direction the rule applies to ('in' | 'out').
// Omitted/null = legacy any-direction rule (e.g. a counterparty-level label).
// A switched-off rule for the same address and direction is switched back on.
export async function upsertCounterpartyRule(params: {
  userId: string;
  address: string;
  label: ClassificationLabel;
  name: string | null;
  direction?: 'in' | 'out' | null;
}): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO counterparty_rules (user_id, address, label, name, confidence, source, direction)
     VALUES ($1, $2, $3, $4, 1.0, 'user', $5::text)
     ON CONFLICT (user_id, address, (COALESCE(direction, '*'))) DO UPDATE
       SET label      = EXCLUDED.label,
           name       = COALESCE(EXCLUDED.name, counterparty_rules.name),
           confidence = 1.0,
           source     = 'user',
           active     = TRUE,
           disabled_at = NULL,
           disabled_reason = NULL,
           updated_at = NOW()
     RETURNING id`,
    [params.userId, params.address.toLowerCase(), params.label, params.name, params.direction ?? null],
  );
  return res.rows[0].id;
}

// The active rule that would label this address in this direction, if any.
export async function getActiveRule(
  userId: string,
  address: string,
  direction: 'in' | 'out',
): Promise<(CounterpartyRuleRow & { id: string }) | null> {
  const res = await query<CounterpartyRuleRow & { id: string }>(
    `SELECT id, address, label, name, confidence, direction FROM counterparty_rules
     WHERE user_id = $1 AND address = $2 AND active`,
    [userId, address.toLowerCase()],
  );
  return findCounterpartyRule(address, direction, res.rows) as (CounterpartyRuleRow & { id: string }) | null;
}

export async function disableRule(ruleId: string, userId: string, reason: string): Promise<void> {
  await query(
    `UPDATE counterparty_rules SET active = FALSE, disabled_at = NOW(), disabled_reason = $3, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [ruleId, userId, reason],
  );
}

// Exchange contracts on Base (checked on BaseScan). A rule learned from one would label
// every later swap through it.
export const SWAP_VENUES = new Set([
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', // Aerodrome Router
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 SwapRouter02
  '0x6ff5693b99212da76ad316178a184ab56d299b43', // Uniswap V4 Universal Router
]);

// A known exchange contract, or an address seen in one of this operator's swaps (as the
// other side of a swapped asset, or as the contract the swap transaction called).
export async function isSwapVenue(userId: string, address: string): Promise<boolean> {
  const addr = address.toLowerCase();
  if (SWAP_VENUES.has(addr)) return true;
  const res = await query<{ venue: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM normalized_events ne
       JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.user_id = $1 AND c.shape = 'swap'
         AND LOWER(CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END) = $2
     ) OR EXISTS (
       SELECT 1 FROM raw_receipts rr
       JOIN wallets w ON w.id = rr.wallet_id
       JOIN normalized_events ne ON LOWER(ne.hash) = LOWER(rr.tx_hash) AND ne.user_id = w.user_id
       JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE w.user_id = $1 AND LOWER(rr.to_address) = $2 AND c.shape = 'swap'
     ) AS venue`,
    [userId, addr],
  );
  return res.rows[0]?.venue ?? false;
}

type NewLabel = {
  label: ClassificationLabel;
  confidence: number;
  method: 'counterparty';
  evidence: string;
  shape: TxShape;
  rule_id: string | null;
  source: 'user' | null;
};

// Writes a new label on each event, under the same lock the classifier and corrections
// take. Never overwrites a label the operator set (unless this write is the operator's).
export async function relabelEvents(userId: string, eventIds: string[], l: NewLabel): Promise<number> {
  if (eventIds.length === 0) return 0;
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    for (const id of [...eventIds].sort()) {
      const locked = await client.query(
        `SELECT id FROM normalized_events WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId],
      );
      if (locked.rows.length === 0) continue;
      if (l.source !== 'user') {
        const user = await client.query(
          `SELECT 1 FROM classifications WHERE event_id = $1 AND superseded_at IS NULL AND source = 'user'`, [id],
        );
        if (user.rows.length > 0) continue;
      }
      await client.query(
        `UPDATE classifications SET superseded_at = NOW() WHERE event_id = $1 AND superseded_at IS NULL`, [id],
      );
      await client.query(
        `INSERT INTO classifications (event_id, user_id, label, confidence, method, evidence, source, shape, rule_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, userId, l.label, l.confidence, l.method, l.evidence, l.source, l.shape, l.rule_id],
      );
      written++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return written;
}

const COUNTERPARTY_SQL = `LOWER(CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END)`;

// Earlier automated labels for this address and direction that a new rule should replace:
// single transfers only (never gas, internal transfers, swaps or complex transactions)
// and never a label the operator set.
export async function eventsForRule(
  userId: string, address: string, direction: 'in' | 'out', label: ClassificationLabel, exceptEventId: string,
): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT ne.id FROM normalized_events ne
     JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1 AND ne.supported IS TRUE AND ne.direction = $3
       AND ${COUNTERPARTY_SQL} = $2 AND ne.id <> $5
       AND c.source IS DISTINCT FROM 'user'
       AND COALESCE(c.shape, 'single') = 'single'
       AND c.method <> 'deterministic'
       AND c.label <> $4::classification_label`,
    [userId, address.toLowerCase(), direction, label, exceptEventId],
  );
  return res.rows.map((r) => r.id);
}

// Labels a switched-off rule produced for this address and direction.
export async function eventsLabeledByRule(
  userId: string, ruleId: string, address: string, direction: 'in' | 'out', exceptEventId: string,
): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT ne.id FROM normalized_events ne
     JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1 AND ne.supported IS TRUE AND ne.direction = $4
       AND ${COUNTERPARTY_SQL} = $3 AND ne.id <> $5
       AND c.source IS NULL AND c.method = 'counterparty'
       AND (c.rule_id = $2 OR c.rule_id IS NULL)`,
    [userId, ruleId, address.toLowerCase(), direction, exceptEventId],
  );
  return res.rows.map((r) => r.id);
}

export type ReviewEvent = {
  id: string;
  hash: string;
  block_time: Date;
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  direction: 'in' | 'out';
  label: string | null;
  confidence: number | null;
  status: string | null;
};

export async function setFailureReason(
  correctionId: string,
  userId: string,
  failureReason: FailureReason,
): Promise<void> {
  await query(
    `UPDATE corrections SET failure_reason = $1
     WHERE id = $2 AND user_id = $3`,
    [failureReason, correctionId, userId],
  );
}

export async function getEventsForReview(params: {
  userId: string;
  label?: string;
  limit?: number;
}): Promise<ReviewEvent[]> {
  const { userId, label = null, limit = 50 } = params;
  const res = await query<ReviewEvent>(
    `SELECT ne.id, ne.hash, ne.block_time, ne.from_address, ne.to_address,
            ne.asset, ne.amount, ne.direction,
            c.label, c.confidence, c.status
     FROM normalized_events ne
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND ($2::text IS NULL OR c.label = $2::classification_label)
     ORDER BY ne.block_time DESC
     LIMIT $3`,
    [userId, label, limit],
  );
  return res.rows;
}
