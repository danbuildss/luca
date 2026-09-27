import { query } from '../db.js';
import { usdValueSql } from '../ingestion/assets.js';
import { significant, usdDisplay } from './breakdown.js';
import { txLink } from '../ledger/links.js';

// "Show me my recent transactions": every supported movement in the period, or only one
// label when the operator asked for one, grouped by on-chain transaction. The ledger is
// movement based, so one transaction can hold several movements (a swap is ETH out, BNKR
// in and its fee): the result counts both, so an answer says "2 transactions, 4
// movements", never "4 transactions". It also says exactly what it covers, so a filtered
// list is never presented as everything that happened.

const USD = usdValueSql('ne');
const COUNTERPARTY = `CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END`;

export type ActivityMovement = {
  event_id: string;
  direction: 'in' | 'out';
  asset: string | null;
  // "fee" for a network fee, otherwise the movement itself
  kind: 'fee' | 'transfer';
  label: string;
  status: string | null;
  counterparty: string | null;
  // Ready to show: "0.0014997 ETH", "$4.06"
  amount_display: string | null;
  usd_display: string | null;
};

export type ActivityTransaction = {
  hash: string;
  // Tappable BaseScan link: "[0x4586…1155](https://basescan.org/tx/…)"
  link: string;
  date: Date;
  movements: ActivityMovement[];
};

export type Activity = {
  // What the list includes, to say in the answer: all transactions or one label
  covers: {
    filter: string;
    period_days: number;
    transactions: number;   // on-chain transactions in the period (all of them, not just listed)
    movements: number;      // movements in those transactions; a swap is two plus its fee
    listed_transactions: number;
    truncated: boolean;
  };
  // Newest first; each transaction with all of its movements that match
  transactions: ActivityTransaction[];
};

export async function getRecentActivity(params: {
  userId: string;
  label: string | null;
  periodDays: number;
  limit: number;        // transactions, not movements
}): Promise<Activity> {
  const res = await query<{
    event_id: string; hash: string; tx_date: Date; direction: 'in' | 'out'; asset: string | null;
    amount: string | null; usd: string | null; source_key: string; label: string | null; status: string | null;
    counterparty: string | null; movements: number; transactions: number;
  }>(
    `WITH m AS (
       SELECT ne.id AS event_id, LOWER(ne.hash) AS hash_key, ne.hash, ne.block_time, ne.direction, ne.asset,
              ne.amount::text AS amount, (${USD})::text AS usd, ne.source_key,
              c.label::text AS label, c.status, ${COUNTERPARTY} AS counterparty
       FROM normalized_events ne
       LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.user_id = $1
         AND ne.supported IS TRUE
         AND ne.block_time >= NOW() - INTERVAL '1 day' * $3
         -- Not classified yet reads the same as unknown to the operator
         AND ($2::text IS NULL OR COALESCE(c.label::text, 'unknown') = $2)
     ), tx AS (
       SELECT hash_key, MAX(block_time) AS tx_date FROM m GROUP BY hash_key
     ), listed AS (
       SELECT hash_key, tx_date FROM tx ORDER BY tx_date DESC, hash_key LIMIT $4
     )
     SELECT m.event_id, m.hash, listed.tx_date, m.direction, m.asset, m.amount, m.usd, m.source_key,
            m.label, m.status, m.counterparty,
            (SELECT COUNT(*)::int FROM m) AS movements,
            (SELECT COUNT(*)::int FROM tx) AS transactions
     FROM listed JOIN m ON m.hash_key = listed.hash_key
     ORDER BY listed.tx_date DESC, listed.hash_key,
              (m.source_key = 'gas'), m.direction DESC, m.source_key`,
    [params.userId, params.label, params.periodDays, Math.max(1, params.limit)],
  );

  const txs = new Map<string, ActivityTransaction>();
  for (const r of res.rows) {
    const key = r.hash.toLowerCase();
    let t = txs.get(key);
    if (!t) {
      t = { hash: r.hash, link: txLink(r.hash), date: r.tx_date, movements: [] };
      txs.set(key, t);
    }
    t.movements.push({
      event_id: r.event_id,
      direction: r.direction,
      asset: r.asset,
      kind: r.source_key === 'gas' ? 'fee' : 'transfer',
      label: r.label ?? 'unknown',
      status: r.status,
      counterparty: r.counterparty,
      amount_display: r.amount != null ? `${significant(parseFloat(r.amount))} ${r.asset ?? ''}`.trim() : null,
      usd_display: r.usd != null ? usdDisplay(parseFloat(r.usd)) : null,
    });
  }

  // The limit is at least 1, so no rows means nothing happened in the period
  const counts = res.rows[0];

  const transactions = [...txs.values()];
  return {
    covers: {
      filter: params.label === null ? 'all transactions' : `only ${params.label}`,
      period_days: params.periodDays,
      transactions: counts?.transactions ?? 0,
      movements: counts?.movements ?? 0,
      listed_transactions: transactions.length,
      truncated: (counts?.transactions ?? 0) > transactions.length,
    },
    transactions,
  };
}
