import { query } from '../db.js';

// Founder metrics, one definition each, shared by /ops and the admin chat tools so the
// two can never disagree. Counts inside each group add up exactly.

// Hours without a successful sync after which a monitored wallet is stale
export const STALE_HOURS = 4;

// Wallets
//   monitored = active wallets
//   ok        = monitored, last sync succeeded within STALE_HOURS
//   stale     = monitored, last sync succeeded but longer ago (or never synced)
//   error     = monitored, last sync failed
//   inactive  = deactivated wallets (not monitored, never stale)
// ok + stale + error = monitored
export type WalletHealth = {
  monitored: number;
  ok: number;
  stale: number;
  error: number;
  inactive: number;
  problems: Array<{ username: string | null; address: string; state: 'stale' | 'error'; last_synced_at: Date | null }>;
};

const WALLET_STATE = `CASE
  WHEN wj.status = 'error' THEN 'error'
  WHEN wj.last_synced_at IS NULL OR wj.last_synced_at < NOW() - ($1::int * INTERVAL '1 hour') THEN 'stale'
  ELSE 'ok' END`;

export async function getWalletHealth(): Promise<WalletHealth> {
  const [counts, problems] = await Promise.all([
    query<{ monitored: number; ok: number; stale: number; error: number; inactive: number }>(
      `SELECT COUNT(*) FILTER (WHERE w.active)::int AS monitored,
              COUNT(*) FILTER (WHERE w.active AND ${WALLET_STATE} = 'ok')::int AS ok,
              COUNT(*) FILTER (WHERE w.active AND ${WALLET_STATE} = 'stale')::int AS stale,
              COUNT(*) FILTER (WHERE w.active AND ${WALLET_STATE} = 'error')::int AS error,
              COUNT(*) FILTER (WHERE NOT w.active)::int AS inactive
       FROM wallets w LEFT JOIN watch_jobs wj ON wj.wallet_id = w.id`,
      [STALE_HOURS],
    ),
    query<{ username: string | null; address: string; state: 'stale' | 'error'; last_synced_at: Date | null }>(
      `SELECT u.telegram_username AS username, w.address, ${WALLET_STATE} AS state, wj.last_synced_at
       FROM wallets w
       JOIN users u ON u.id = w.user_id
       LEFT JOIN watch_jobs wj ON wj.wallet_id = w.id
       WHERE w.active AND ${WALLET_STATE} <> 'ok'
       ORDER BY wj.last_synced_at ASC NULLS FIRST`,
      [STALE_HOURS],
    ),
  ]);
  const c = counts.rows[0];
  return {
    monitored: c?.monitored ?? 0, ok: c?.ok ?? 0, stale: c?.stale ?? 0, error: c?.error ?? 0,
    inactive: c?.inactive ?? 0, problems: problems.rows,
  };
}

// Invites
//   invited   = every invite ever created
//   pending   = active invite, the person has not opened the bot yet
//   joined    = active invite, opened the bot, no wallet synced yet
//   activated = active invite, at least one wallet synced (users.activated_at set)
//   revoked   = access removed
// pending + joined + activated + revoked = invited. Admins without an invite are users,
// not invites, and are not counted here.
export type InviteStats = {
  invited: number;
  pending: number;
  joined: number;
  activated: number;
  revoked: number;
  not_activated: Array<{ username: string | null; state: 'pending' | 'joined'; invited_at: Date }>;
};

const INVITE_STATE = `CASE
  WHEN i.status = 'revoked' THEN 'revoked'
  WHEN i.telegram_id < 0 THEN 'pending'
  WHEN u.activated_at IS NOT NULL THEN 'activated'
  ELSE 'joined' END`;

export async function getInviteStats(): Promise<InviteStats> {
  const res = await query<{ username: string | null; state: string; invited_at: Date }>(
    `SELECT LTRIM(COALESCE(i.telegram_username, u.telegram_username), '@') AS username,
            ${INVITE_STATE} AS state, i.invited_at
     FROM beta_invites i
     LEFT JOIN users u ON u.telegram_id = i.telegram_id
     ORDER BY i.invited_at ASC`,
  );
  const count = (s: string): number => res.rows.filter((r) => r.state === s).length;
  return {
    invited: res.rows.length,
    pending: count('pending'),
    joined: count('joined'),
    activated: count('activated'),
    revoked: count('revoked'),
    not_activated: res.rows
      .filter((r) => r.state === 'pending' || r.state === 'joined')
      .map((r) => ({ username: r.username, state: r.state as 'pending' | 'joined', invited_at: r.invited_at })),
  };
}

// Users
//   total     = everyone with an account (operators and admins)
//   activated = at least one wallet synced
//   active_24h / active_7d = sent Luca a message in that window
export type UserStats = { total: number; admins: number; activated: number; active_24h: number; active_7d: number };

export async function getUserStats(): Promise<UserStats> {
  const res = await query<UserStats>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE role = 'admin')::int AS admins,
            COUNT(*) FILTER (WHERE activated_at IS NOT NULL)::int AS activated,
            COUNT(*) FILTER (WHERE last_user_active_at > NOW() - INTERVAL '24 hours')::int AS active_24h,
            COUNT(*) FILTER (WHERE last_user_active_at > NOW() - INTERVAL '7 days')::int AS active_7d
     FROM users`,
  );
  return res.rows[0] ?? { total: 0, admins: 0, activated: 0, active_24h: 0, active_7d: 0 };
}

// AI spend recorded in llm_spend_log, by purpose, for today (UTC), the last 7 and 30 days.
// Calls to a model without a known price are logged with their tokens at $0 and listed in
// unpriced_models_7d, so the total is a floor rather than a silent undercount.
export type AiCost = {
  today_usd: number;
  last_7d_usd: number;
  last_30d_usd: number;
  by_purpose_7d: Array<{ purpose: string; usd: number; calls: number; tokens: number }>;
  unpriced_models_7d: string[];
};

export async function getAiCost(): Promise<AiCost> {
  const [totals, purposes, unpriced] = await Promise.all([
    query<{ today: string | null; d7: string | null; d30: string | null }>(
      `SELECT SUM(cost_usd) FILTER (WHERE created_at >= date_trunc('day', NOW()))::text AS today,
              SUM(cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::text AS d7,
              SUM(cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::text AS d30
       FROM llm_spend_log`,
    ),
    query<{ purpose: string; usd: string; calls: number; tokens: number }>(
      `SELECT COALESCE(purpose, 'other') AS purpose, SUM(cost_usd)::text AS usd, COUNT(*)::int AS calls,
              SUM(input_tokens + output_tokens)::int AS tokens
       FROM llm_spend_log WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY 1 ORDER BY SUM(cost_usd) DESC`,
    ),
    query<{ model: string }>(
      `SELECT model FROM llm_spend_log WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY model HAVING SUM(cost_usd) = 0 AND SUM(input_tokens + output_tokens) > 0
       ORDER BY model`,
    ),
  ]);
  const t = totals.rows[0];
  const n = (v: string | null | undefined): number => (v ? parseFloat(v) : 0);
  return {
    today_usd: n(t?.today),
    last_7d_usd: n(t?.d7),
    last_30d_usd: n(t?.d30),
    by_purpose_7d: purposes.rows.map((p) => ({ purpose: p.purpose, usd: parseFloat(p.usd), calls: p.calls, tokens: p.tokens })),
    unpriced_models_7d: unpriced.rows.map((r) => r.model),
  };
}
