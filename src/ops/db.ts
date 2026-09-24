import { query } from '../db.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpsOperatorRow = {
  user_id: string;
  telegram_id: string;
  username: string | null;
  role: string;
  joined_at: Date;
  activated_at: Date | null;
  last_user_active_at: Date | null;
  active_wallets: number;
  total_wallets: number;
  last_synced_at: Date | null;
  has_sync_error: boolean;
  error_wallet_count: number;
  hours_since_sync: number | null;
  total_events: number;
  unknown_count: number;
  last_brief_sent_at: Date | null;
  balance_usdc: number;
  unknown_count_7d: number;
  worker_last_ping: Date;
  worker_minutes_stale: number;
};

// ---------------------------------------------------------------------------
// Overview: system-wide stats for the top panel
// ---------------------------------------------------------------------------

export async function getOpsOverview(): Promise<{
  total_operators: number;
  activated_operators: number;
  active_24h: number;
  active_7d: number;
  total_wallets: number;
  stale_wallets: number;
  error_wallets: number;
  worker_last_ping: Date | null;
  worker_loop_count: number;
  worker_minutes_stale: number | null;
  ingested_24h: number;
  unacked_alerts: number;
  briefs_failed_24h: number;
  llm_cost_24h: number;
  llm_cost_7d: number;
  total_unknown: number;
}> {
  const [ops, worker, ingested, alerts, briefs, cost, unknown] = await Promise.all([
    query<{
      total: string; activated: string; active_24h: string; active_7d: string;
      total_wallets: string; stale_wallets: string; error_wallets: string;
    }>(`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE u.activated_at IS NOT NULL)::text AS activated,
        COUNT(*) FILTER (WHERE u.last_user_active_at > NOW() - INTERVAL '24 hours')::text AS active_24h,
        COUNT(*) FILTER (WHERE u.last_user_active_at > NOW() - INTERVAL '7 days')::text AS active_7d,
        (SELECT COUNT(*)::text FROM wallets WHERE active = TRUE) AS total_wallets,
        (SELECT COUNT(*)::text FROM watch_jobs WHERE status = 'active'
          AND last_synced_at < NOW() - INTERVAL '4 hours') AS stale_wallets,
        (SELECT COUNT(*)::text FROM watch_jobs WHERE status = 'error') AS error_wallets
      FROM users u
    `),

    query<{ last_ping_at: Date; loop_count: string }>(
      `SELECT last_ping_at, loop_count FROM worker_heartbeat WHERE id = 1`,
    ),

    query<{ count: string }>(
      `SELECT COALESCE(SUM(events_ingested), 0)::text AS count
       FROM sync_runs WHERE started_at > NOW() - INTERVAL '24 hours' AND status = 'completed'`,
    ),

    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts
       WHERE acknowledged_at IS NULL AND sent_at > NOW() - INTERVAL '7 days'`,
    ),

    // Briefs where telegram delivery failed (saved but no telegram_message_id after an hour)
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM briefs
       WHERE telegram_message_id IS NULL AND created_at < NOW() - INTERVAL '1 hour'
         AND created_at > NOW() - INTERVAL '24 hours'`,
    ),

    query<{ cost_24h: string; cost_7d: string }>(
      `SELECT
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::text AS cost_24h,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0)::text AS cost_7d
       FROM llm_spend_log`,
    ),

    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM classifications
       WHERE label = 'unknown' AND superseded_at IS NULL`,
    ),
  ]);

  const w = worker.rows[0];
  const opsRow = ops.rows[0];
  return {
    total_operators: parseInt(opsRow?.total ?? '0'),
    activated_operators: parseInt(opsRow?.activated ?? '0'),
    active_24h: parseInt(opsRow?.active_24h ?? '0'),
    active_7d: parseInt(opsRow?.active_7d ?? '0'),
    total_wallets: parseInt(opsRow?.total_wallets ?? '0'),
    stale_wallets: parseInt(opsRow?.stale_wallets ?? '0'),
    error_wallets: parseInt(opsRow?.error_wallets ?? '0'),
    worker_last_ping: w?.last_ping_at ?? null,
    worker_loop_count: Number(w?.loop_count ?? 0),
    worker_minutes_stale: w ? (Date.now() - new Date(w.last_ping_at).getTime()) / 60000 : null,
    ingested_24h: parseInt(ingested.rows[0]?.count ?? '0'),
    unacked_alerts: parseInt(alerts.rows[0]?.count ?? '0'),
    briefs_failed_24h: parseInt(briefs.rows[0]?.count ?? '0'),
    llm_cost_24h: parseFloat(cost.rows[0]?.cost_24h ?? '0'),
    llm_cost_7d: parseFloat(cost.rows[0]?.cost_7d ?? '0'),
    total_unknown: parseInt(unknown.rows[0]?.count ?? '0'),
  };
}

// ---------------------------------------------------------------------------
// Operators list: all users for the operators table
// ---------------------------------------------------------------------------

export async function getOpsOperators(): Promise<OpsOperatorRow[]> {
  const res = await query<{
    user_id: string; telegram_id: string; username: string | null; role: string;
    joined_at: Date; activated_at: Date | null; last_user_active_at: Date | null;
    active_wallets: string; total_wallets: string; last_synced_at: Date | null;
    has_sync_error: boolean; error_wallet_count: string; hours_since_sync: string | null;
    total_events: string; unknown_count: string; last_brief_sent_at: Date | null;
    balance_usdc: string; unknown_count_7d: string;
    worker_last_ping: Date; worker_minutes_stale: string;
  }>(`
    SELECT user_id, telegram_id, username, role, joined_at, activated_at,
           last_user_active_at, active_wallets, total_wallets, last_synced_at,
           has_sync_error, error_wallet_count, hours_since_sync, total_events,
           unknown_count, last_brief_sent_at, balance_usdc, unknown_count_7d,
           worker_last_ping, worker_minutes_stale
    FROM ops_daily_summary
    ORDER BY joined_at DESC
  `);

  return res.rows.map((r) => ({
    user_id: r.user_id,
    telegram_id: r.telegram_id,
    username: r.username,
    role: r.role,
    joined_at: r.joined_at,
    activated_at: r.activated_at,
    last_user_active_at: r.last_user_active_at,
    active_wallets: parseInt(r.active_wallets ?? '0'),
    total_wallets: parseInt(r.total_wallets ?? '0'),
    last_synced_at: r.last_synced_at,
    has_sync_error: r.has_sync_error,
    error_wallet_count: parseInt(r.error_wallet_count ?? '0'),
    hours_since_sync: r.hours_since_sync ? parseFloat(r.hours_since_sync) : null,
    total_events: parseInt(r.total_events ?? '0'),
    unknown_count: parseInt(r.unknown_count ?? '0'),
    last_brief_sent_at: r.last_brief_sent_at,
    balance_usdc: parseFloat(r.balance_usdc ?? '0'),
    unknown_count_7d: parseInt(r.unknown_count_7d ?? '0'),
    worker_last_ping: r.worker_last_ping,
    worker_minutes_stale: parseFloat(r.worker_minutes_stale ?? '0'),
  }));
}

// ---------------------------------------------------------------------------
// Per-operator detail
// ---------------------------------------------------------------------------

export async function getOpsOperatorDetail(userId: string): Promise<{
  user: {
    user_id: string; username: string | null; telegram_id: string; role: string;
    joined_at: Date; activated_at: Date | null; last_user_active_at: Date | null;
    materiality_usd: number; timezone: string; brief_time: string;
  } | null;
  wallets: Array<{
    address: string; label: string | null; chain: string; active: boolean;
    status: string | null; last_synced_at: Date | null; error_message: string | null;
    event_count: number;
    ledger_status: string | null; incomplete_since_at: Date | null; last_reconciled_at: Date | null;
  }>;
  recent_sync_runs: Array<{
    started_at: Date; status: string; provider: string; events_ingested: number | null;
    error_message: string | null; duration_seconds: number | null;
  }>;
  quality: {
    total_classified: number; unknown_count: number; unknown_pct: number;
    correction_count: number; high_confidence_errors: number;
  };
  recent_alerts: Array<{ type: string; message: string; sent_at: Date; acknowledged_at: Date | null }>;
  last_brief: { type: string; sent_at: Date | null; content_preview: string } | null;
  correction_count_30d: number;
}> {
  const [userRes, walletsRes, syncRes, qualityRes, alertsRes, briefRes, corrRes] = await Promise.all([
    query<{
      id: string; username: string | null; telegram_id: string; role: string;
      created_at: Date; activated_at: Date | null; last_user_active_at: Date | null;
      materiality_usd: string; timezone: string; brief_time: string;
    }>(
      `SELECT id, telegram_username AS username, telegram_id::text, role::text, created_at, activated_at,
              last_user_active_at, materiality_usd::text, timezone, brief_time
       FROM users WHERE id = $1`,
      [userId],
    ),

    query<{
      address: string; label: string | null; chain: string; active: boolean;
      status: string | null; last_synced_at: Date | null; error_message: string | null;
      event_count: string;
      ledger_status: string | null; incomplete_since_at: Date | null; last_reconciled_at: Date | null;
    }>(
      `SELECT w.address, w.label, w.chain, w.active,
              wj.status, wj.last_synced_at, wj.error_message,
              COUNT(ne.id)::text AS event_count,
              wj.ledger_status, wj.incomplete_since_at, wj.last_reconciled_at
       FROM wallets w
       LEFT JOIN watch_jobs wj ON wj.wallet_id = w.id
       LEFT JOIN normalized_events ne ON ne.wallet_id = w.id AND ne.supported IS TRUE
       WHERE w.user_id = $1
       GROUP BY w.id, wj.status, wj.last_synced_at, wj.error_message,
                wj.ledger_status, wj.incomplete_since_at, wj.last_reconciled_at
       ORDER BY w.created_at ASC`,
      [userId],
    ),

    query<{
      started_at: Date; status: string; provider: string;
      events_ingested: string | null; error_message: string | null; duration_seconds: string | null;
    }>(
      `SELECT sr.started_at, sr.status, sr.provider,
              sr.events_ingested::text, sr.error_message,
              EXTRACT(EPOCH FROM (sr.completed_at - sr.started_at))::text AS duration_seconds
       FROM sync_runs sr
       JOIN wallets w ON w.id = sr.wallet_id
       WHERE w.user_id = $1
       ORDER BY sr.started_at DESC LIMIT 10`,
      [userId],
    ),

    query<{
      total_classified: string; unknown_count: string; correction_count: string; high_confidence_errors: string;
    }>(
      `SELECT
        COUNT(DISTINCT c.id)::text AS total_classified,
        COUNT(DISTINCT c.id) FILTER (WHERE c.label = 'unknown')::text AS unknown_count,
        COUNT(DISTINCT cr.id)::text AS correction_count,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.old_confidence > 0.8)::text AS high_confidence_errors
       FROM classifications c
       -- corrections.classification_id points at the (now superseded) wrong row, so match
       -- the active classification to its corrections by event instead.
       LEFT JOIN corrections cr ON cr.event_id = c.event_id AND cr.type = 'tx' AND cr.user_id = $1
       WHERE c.user_id = $1 AND c.superseded_at IS NULL`,
      [userId],
    ),

    query<{ type: string; message: string; sent_at: Date; acknowledged_at: Date | null }>(
      `SELECT type, message, sent_at, acknowledged_at
       FROM alerts WHERE user_id = $1
       ORDER BY sent_at DESC LIMIT 5`,
      [userId],
    ),

    query<{ type: string; sent_at: Date | null; content: string }>(
      `SELECT type, sent_at, content FROM briefs
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),

    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM corrections
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
      [userId],
    ),
  ]);

  const u = userRes.rows[0];
  const q = qualityRes.rows[0];
  const total = parseInt(q?.total_classified ?? '0');
  const unknown = parseInt(q?.unknown_count ?? '0');

  return {
    user: u ? {
      user_id: u.id,
      username: u.username,
      telegram_id: u.telegram_id,
      role: u.role,
      joined_at: u.created_at,
      activated_at: u.activated_at,
      last_user_active_at: u.last_user_active_at,
      materiality_usd: parseFloat(u.materiality_usd ?? '100'),
      timezone: u.timezone,
      brief_time: u.brief_time,
    } : null,
    wallets: walletsRes.rows.map((r) => ({
      ...r,
      event_count: parseInt(r.event_count),
    })),
    recent_sync_runs: syncRes.rows.map((r) => ({
      started_at: r.started_at,
      status: r.status,
      provider: r.provider,
      events_ingested: r.events_ingested ? parseInt(r.events_ingested) : null,
      error_message: r.error_message,
      duration_seconds: r.duration_seconds ? parseFloat(r.duration_seconds) : null,
    })),
    quality: {
      total_classified: total,
      unknown_count: unknown,
      unknown_pct: total > 0 ? (unknown / total) * 100 : 0,
      correction_count: parseInt(q?.correction_count ?? '0'),
      high_confidence_errors: parseInt(q?.high_confidence_errors ?? '0'),
    },
    recent_alerts: alertsRes.rows,
    last_brief: briefRes.rows[0] ? {
      type: briefRes.rows[0].type,
      sent_at: briefRes.rows[0].sent_at,
      content_preview: briefRes.rows[0].content.slice(0, 200),
    } : null,
    correction_count_30d: parseInt(corrRes.rows[0]?.count ?? '0'),
  };
}

// ---------------------------------------------------------------------------
// Errors: sync failures, stale wallets, brief delivery failures
// ---------------------------------------------------------------------------

export async function getOpsErrors(): Promise<{
  sync_errors: Array<{ username: string | null; address: string; error_message: string; updated_at: Date }>;
  stale_wallets: Array<{ username: string | null; address: string; hours_stale: number; last_synced_at: Date | null }>;
  failed_briefs: Array<{ username: string | null; type: string; created_at: Date }>;
}> {
  const [syncErrors, stale, briefs] = await Promise.all([
    query<{ username: string | null; address: string; error_message: string; updated_at: Date }>(
      `SELECT u.telegram_username AS username, w.address, wj.error_message, wj.updated_at
       FROM watch_jobs wj
       JOIN wallets w ON w.id = wj.wallet_id
       JOIN users u ON u.id = w.user_id
       WHERE wj.status = 'error'
       ORDER BY wj.updated_at DESC`,
    ),

    query<{ username: string | null; address: string; hours_stale: string; last_synced_at: Date | null }>(
      `SELECT u.telegram_username AS username, w.address, wj.last_synced_at,
              EXTRACT(EPOCH FROM (NOW() - COALESCE(wj.last_synced_at, NOW() - INTERVAL '48 hours'))) / 3600 AS hours_stale
       FROM watch_jobs wj
       JOIN wallets w ON w.id = wj.wallet_id
       JOIN users u ON u.id = w.user_id
       WHERE wj.status = 'active'
         AND COALESCE(wj.last_synced_at, NOW() - INTERVAL '48 hours') < NOW() - INTERVAL '4 hours'
       ORDER BY hours_stale DESC`,
    ),

    query<{ username: string | null; type: string; created_at: Date }>(
      `SELECT u.telegram_username AS username, b.type, b.created_at
       FROM briefs b
       JOIN users u ON u.id = b.user_id
       WHERE b.telegram_message_id IS NULL
         AND b.created_at < NOW() - INTERVAL '1 hour'
         AND b.created_at > NOW() - INTERVAL '48 hours'
       ORDER BY b.created_at DESC`,
    ),
  ]);

  return {
    sync_errors: syncErrors.rows,
    stale_wallets: stale.rows.map((r) => ({ ...r, hours_stale: parseFloat(r.hours_stale) })),
    failed_briefs: briefs.rows,
  };
}

// ---------------------------------------------------------------------------
// Quality: classifier health across all users
// ---------------------------------------------------------------------------

export async function getOpsQuality(): Promise<{
  total_classified: number;
  unknown_count: number;
  unknown_pct: number;
  correction_count: number;
  correction_pct: number;
  high_confidence_errors: number;
  method_breakdown: Array<{ method: string; total: number; error_count: number; error_rate: number }>;
  failure_reasons: Array<{ reason: string; count: number }>;
  weekly_trend: Array<{ week_start: Date; unknown_rate: number; correction_rate: number; total_classified: number }>;
}> {
  const [health, methods, reasons, trend] = await Promise.all([
    query<{
      total: string; unknown: string; corrections: string; hce: string;
    }>(
      `SELECT
        COUNT(DISTINCT c.id)::text AS total,
        COUNT(DISTINCT c.id) FILTER (WHERE c.label = 'unknown')::text AS unknown,
        COUNT(DISTINCT cr.id)::text AS corrections,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.old_confidence > 0.8)::text AS hce
       FROM classifications c
       -- corrections.classification_id points at the superseded (wrong) row; match by event
       LEFT JOIN corrections cr ON cr.event_id = c.event_id AND cr.type = 'tx'
       WHERE c.superseded_at IS NULL`,
    ),

    // Error rate per method of the classification that was wrong: active rows plus
    // superseded rows that a correction points at (via classification_id).
    query<{ method: string; total: string; error_count: string }>(
      `SELECT c.method, COUNT(DISTINCT c.id)::text AS total, COUNT(DISTINCT cr.classification_id)::text AS error_count
       FROM classifications c
       LEFT JOIN corrections cr ON cr.classification_id = c.id
       WHERE c.confidence > 0.8 AND (c.superseded_at IS NULL OR cr.id IS NOT NULL)
       GROUP BY c.method
       ORDER BY COUNT(DISTINCT cr.classification_id)::float / NULLIF(COUNT(DISTINCT c.id), 0) DESC`,
    ),

    query<{ failure_reason: string; count: string }>(
      `SELECT failure_reason::text, COUNT(*)::text AS count
       FROM corrections WHERE failure_reason IS NOT NULL
       GROUP BY failure_reason ORDER BY COUNT(*) DESC`,
    ),

    // System-wide weekly trend: one row per week across all users. Rates are recomputed
    // from summed counts (not averaged per-user rates). Queried directly rather than via
    // quality_weekly_trend, whose correction join (classification_id = active row) is always empty.
    query<{ week_start: Date; total_classified: string; unknown_count: string; corrected_count: string }>(
      `SELECT DATE_TRUNC('week', ne.block_time) AS week_start,
              COUNT(DISTINCT c.id)::text AS total_classified,
              COUNT(DISTINCT c.id) FILTER (WHERE c.label = 'unknown')::text AS unknown_count,
              COUNT(DISTINCT c.id) FILTER (WHERE cr.id IS NOT NULL)::text AS corrected_count
       FROM classifications c
       JOIN normalized_events ne ON ne.id = c.event_id
       LEFT JOIN corrections cr ON cr.event_id = c.event_id AND cr.type = 'tx'
       WHERE c.superseded_at IS NULL
         AND ne.supported IS TRUE
         AND ne.block_time >= DATE_TRUNC('week', NOW()) - INTERVAL '7 weeks'
       GROUP BY DATE_TRUNC('week', ne.block_time)
       ORDER BY week_start DESC`,
    ),
  ]);

  const h = health.rows[0];
  const total = parseInt(h?.total ?? '0');
  const unknown = parseInt(h?.unknown ?? '0');
  const corrections = parseInt(h?.corrections ?? '0');

  return {
    total_classified: total,
    unknown_count: unknown,
    unknown_pct: total > 0 ? (unknown / total) * 100 : 0,
    correction_count: corrections,
    correction_pct: total > 0 ? (corrections / total) * 100 : 0,
    high_confidence_errors: parseInt(h?.hce ?? '0'),
    method_breakdown: methods.rows.map((r) => {
      const t = parseInt(r.total);
      const e = parseInt(r.error_count);
      return { method: r.method, total: t, error_count: e, error_rate: t > 0 ? e / t : 0 };
    }),
    failure_reasons: reasons.rows.map((r) => ({ reason: r.failure_reason, count: parseInt(r.count) })),
    weekly_trend: trend.rows.map((r) => {
      const t = parseInt(r.total_classified ?? '0');
      const u = parseInt(r.unknown_count ?? '0');
      const cc = parseInt(r.corrected_count ?? '0');
      return {
        week_start: r.week_start,
        unknown_rate: t > 0 ? u / t : 0,
        correction_rate: t > 0 ? cc / t : 0,
        total_classified: t,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// System health: worker + recent sync runs
// ---------------------------------------------------------------------------

export async function getOpsSystem(): Promise<{
  worker: { last_ping_at: Date; loop_count: number; minutes_stale: number } | null;
  recent_sync_runs: Array<{
    started_at: Date; status: string; provider: string;
    events_ingested: number | null; error_message: string | null;
    wallet_address: string; username: string | null;
  }>;
}> {
  const [workerRes, syncsRes] = await Promise.all([
    query<{ last_ping_at: Date; loop_count: string }>(
      `SELECT last_ping_at, loop_count FROM worker_heartbeat WHERE id = 1`,
    ),
    query<{
      started_at: Date; status: string; provider: string;
      events_ingested: string | null; error_message: string | null;
      wallet_address: string; username: string | null;
    }>(
      `SELECT sr.started_at, sr.status, sr.provider,
              sr.events_ingested::text, sr.error_message,
              w.address AS wallet_address, u.telegram_username AS username
       FROM sync_runs sr
       JOIN wallets w ON w.id = sr.wallet_id
       JOIN users u ON u.id = w.user_id
       ORDER BY sr.started_at DESC LIMIT 20`,
    ),
  ]);

  const w = workerRes.rows[0];
  return {
    worker: w ? {
      last_ping_at: w.last_ping_at,
      loop_count: Number(w.loop_count),
      minutes_stale: (Date.now() - new Date(w.last_ping_at).getTime()) / 60000,
    } : null,
    recent_sync_runs: syncsRes.rows.map((r) => ({
      ...r,
      events_ingested: r.events_ingested ? parseInt(r.events_ingested) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// LLM cost: daily breakdown and totals
// ---------------------------------------------------------------------------

export async function getOpsCost(days = 30): Promise<{
  daily: Array<{ day: string; cost_usd: number; tokens: number }>;
  total_7d: number;
  total_30d: number;
  by_model: Array<{ model: string; cost_usd: number; calls: number }>;
  by_purpose: Array<{ purpose: string; cost_usd: number; calls: number }>;
}> {
  const [daily, totals, byModel, byPurpose] = await Promise.all([
    query<{ day: string; cost_usd: string; tokens: string }>(
      `SELECT TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS day,
              ROUND(SUM(cost_usd)::numeric, 4)::text AS cost_usd,
              SUM(input_tokens + output_tokens)::text AS tokens
       FROM llm_spend_log
       WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
       GROUP BY DATE_TRUNC('day', created_at)
       ORDER BY day DESC`,
      [days.toString()],
    ),

    query<{ cost_7d: string; cost_30d: string }>(
      `SELECT
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0)::text AS cost_7d,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::text AS cost_30d
       FROM llm_spend_log`,
    ),

    query<{ model: string; cost_usd: string; calls: string }>(
      `SELECT model, ROUND(SUM(cost_usd)::numeric, 4)::text AS cost_usd, COUNT(*)::text AS calls
       FROM llm_spend_log WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY model ORDER BY SUM(cost_usd) DESC`,
    ),

    query<{ purpose: string; cost_usd: string; calls: string }>(
      `SELECT COALESCE(purpose, 'unknown') AS purpose,
              ROUND(SUM(cost_usd)::numeric, 4)::text AS cost_usd, COUNT(*)::text AS calls
       FROM llm_spend_log WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY purpose ORDER BY SUM(cost_usd) DESC`,
    ),
  ]);

  return {
    daily: daily.rows.map((r) => ({
      day: r.day,
      cost_usd: parseFloat(r.cost_usd),
      tokens: parseInt(r.tokens),
    })),
    total_7d: parseFloat(totals.rows[0]?.cost_7d ?? '0'),
    total_30d: parseFloat(totals.rows[0]?.cost_30d ?? '0'),
    by_model: byModel.rows.map((r) => ({
      model: r.model,
      cost_usd: parseFloat(r.cost_usd),
      calls: parseInt(r.calls),
    })),
    by_purpose: byPurpose.rows.map((r) => ({
      purpose: r.purpose,
      cost_usd: parseFloat(r.cost_usd),
      calls: parseInt(r.calls),
    })),
  };
}

// ---------------------------------------------------------------------------
// Activity touch — update last_user_active_at for a real human action
// ---------------------------------------------------------------------------

// Fire-and-forget from bot handlers — never throws.
export async function touchUserActivity(userId: string): Promise<void> {
  try {
    await query(
      `UPDATE users SET last_user_active_at = NOW() WHERE id = $1`,
      [userId],
    );
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to touch user activity');
  }
}

// ---------------------------------------------------------------------------
// Activation — set activated_at when first wallet sync completes
// ---------------------------------------------------------------------------

export async function touchUserActivation(userId: string): Promise<void> {
  await query(
    `UPDATE users SET activated_at = NOW() WHERE id = $1 AND activated_at IS NULL`,
    [userId],
  );
}
