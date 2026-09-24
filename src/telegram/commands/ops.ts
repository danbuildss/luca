import type { Context } from 'telegraf';
import type { AuthedUser } from '../auth.js';
import {
  getOpsOverview,
  getOpsErrors,
  getOpsOperators,
  getOpsOperatorDetail,
} from '../../ops/db.js';
import { query } from '../../db.js';
import { getLedgerHealth } from '../../ledger/status.js';
import { escapeLegacyMarkdown, replyMarkdownSafe } from '../format.js';

// Escape DB/user-controlled text for legacy Markdown (usernames often contain `_`).
function md(value: string | number | null | undefined): string {
  return escapeLegacyMarkdown(String(value ?? ''));
}

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function ago(d: Date | null): string {
  if (!d) return 'never';
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function workerStatus(minutesStale: number | null): string {
  if (minutesStale === null) return 'unknown';
  if (minutesStale < 5) return 'alive';
  if (minutesStale < 15) return 'slow';
  return `stale (${fmt(minutesStale)}m)`;
}

// /ops — system overview
async function handleOpsOverview(ctx: Context): Promise<void> {
  const [ov, ledger] = await Promise.all([getOpsOverview(), getLedgerHealth()]);

  const lines = [
    `*Luca ops overview*`,
    ``,
    `*Operators*`,
    `  Total: ${ov.total_operators}  |  Activated: ${ov.activated_operators}  |  Active 24h: ${ov.active_24h}  |  7d: ${ov.active_7d}`,
    ``,
    `*Wallets*`,
    `  Monitored: ${ov.total_wallets}  |  Stale: ${ov.stale_wallets}  |  Error: ${ov.error_wallets}`,
    ``,
    `*Worker*`,
    `  ${workerStatus(ov.worker_minutes_stale)}  |  Loop: ${fmt(ov.worker_loop_count)}  |  Ping: ${ago(ov.worker_last_ping)}`,
    ``,
    `*Books vs chain*`,
    `  Complete: ${ledger.complete}  |  Incomplete: ${ledger.incomplete}  |  Not yet checked: ${ledger.unchecked}`,
    `  Repairs 7d: ${ledger.repairs_7d}  |  Missed by feed, caught by logs 7d: ${ledger.log_gaps_7d}`,
    `  Blockscout ranges waiting for re-read: ${ledger.degraded_pending}`,
    ``,
    `*Quality*`,
    `  Unknown total: ${ov.total_unknown}  |  Unacked alerts: ${ov.unacked_alerts}`,
    `  Brief failures (24h): ${ov.briefs_failed_24h}`,
    ``,
    `*LLM Cost*`,
    `  24h: $${fmt(ov.llm_cost_24h, 3)}  |  7d: $${fmt(ov.llm_cost_7d, 2)}`,
    `  Ingested 24h: ${fmt(ov.ingested_24h)} events`,
    ``,
    `_/ops @username — per-user view_`,
    `_/ops errors — current failures_`,
  ];

  await replyMarkdownSafe(ctx, lines.join('\n'));
}

// /ops errors — sync failures, stale wallets, brief failures
async function handleOpsErrors(ctx: Context): Promise<void> {
  const [errors, ledger] = await Promise.all([getOpsErrors(), getLedgerHealth()]);
  const lines: string[] = [`*Current errors*`, ``];

  if (ledger.incomplete_wallets.length > 0) {
    lines.push(`*Incomplete books (${ledger.incomplete_wallets.length})*`);
    for (const w of ledger.incomplete_wallets.slice(0, 5)) {
      const who = md(w.username ?? 'unknown');
      const addr = md(w.address.slice(0, 10)) + '…';
      const since = w.since_at ? ago(w.since_at) : `block ${md(w.since_block ?? '?')}`;
      lines.push(`  @${who} ${addr} — unexplained balance change since ${since}`);
    }
    lines.push('');
  }

  if (ledger.incomplete_wallets.length === 0 && errors.sync_errors.length === 0
    && errors.stale_wallets.length === 0 && errors.failed_briefs.length === 0) {
    lines.push('Nothing is broken right now.');
    await replyMarkdownSafe(ctx, lines.join('\n'));
    return;
  }

  if (errors.sync_errors.length > 0) {
    lines.push(`*Sync Errors (${errors.sync_errors.length})*`);
    for (const e of errors.sync_errors.slice(0, 5)) {
      const who = md(e.username ?? 'unknown');
      const addr = md(e.address.slice(0, 10)) + '…';
      lines.push(`  @${who} ${addr} — ${md((e.error_message ?? '').slice(0, 60))}`);
    }
    lines.push('');
  }

  if (errors.stale_wallets.length > 0) {
    lines.push(`*Stale Wallets (${errors.stale_wallets.length})*`);
    for (const w of errors.stale_wallets.slice(0, 5)) {
      const who = md(w.username ?? 'unknown');
      const addr = md(w.address.slice(0, 10)) + '…';
      lines.push(`  @${who} ${addr} — ${fmt(w.hours_stale, 1)}h stale`);
    }
    lines.push('');
  }

  if (errors.failed_briefs.length > 0) {
    lines.push(`*Failed Brief Deliveries (${errors.failed_briefs.length})*`);
    for (const b of errors.failed_briefs.slice(0, 3)) {
      lines.push(`  @${md(b.username ?? 'unknown')} — ${md(b.type)} brief (${ago(b.created_at)})`);
    }
  }

  await replyMarkdownSafe(ctx, lines.join('\n'));
}

// /ops @username — per-user detail
async function handleOpsUser(ctx: Context, handle: string): Promise<void> {
  const clean = handle.replace('@', '').toLowerCase();

  // Resolve by username or telegram_id or user_id prefix
  const resolved = await query<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(telegram_username) = $1 OR telegram_id::text = $1 OR id::text LIKE $2 LIMIT 1`,
    [clean, `${clean}%`],
  );
  if (!resolved.rows[0]) {
    await ctx.reply(`User "${handle}" not found.`);
    return;
  }

  const detail = await getOpsOperatorDetail(resolved.rows[0].id);
  if (!detail.user) { await ctx.reply('User not found.'); return; }

  const u = detail.user;
  const q = detail.quality;
  const syncOk = detail.wallets.every((w) => w.status !== 'error');

  const lines = [
    `*@${md(u.username ?? u.telegram_id)}*`,
    ``,
    `Joined: ${ago(u.joined_at)}  |  Activated: ${u.activated_at ? ago(u.activated_at) : '—'}`,
    `Last active: ${ago(u.last_user_active_at)}  |  Role: ${md(u.role)}`,
    `TZ: ${md(u.timezone)}  |  Brief: ${md(u.brief_time)}`,
    ``,
    `*Wallets (${detail.wallets.length})*`,
    ...detail.wallets.map((w) => {
      const status = w.status === 'error' ? 'Error ' : w.active ? 'OK    ' : 'Paused';
      const addr = md(w.address.slice(0, 10)) + '…';
      const books = w.ledger_status === 'complete'
        ? `books OK (checked ${ago(w.last_reconciled_at)})`
        : w.ledger_status === 'incomplete'
          ? `books INCOMPLETE since ${ago(w.incomplete_since_at)}`
          : 'books not yet checked';
      return `  ${status} ${addr}${w.label ? ` (${md(w.label)})` : ''}  ${fmt(w.event_count)} events  sync: ${ago(w.last_synced_at)}  ${books}`;
    }),
    ``,
    `*Quality*`,
    `  Classified: ${fmt(q.total_classified)}  |  Unknown: ${fmt(q.unknown_count)} (${fmt(q.unknown_pct, 1)}%)`,
    `  Corrections: ${fmt(q.correction_count)}  |  High-conf errors: ${q.high_confidence_errors}`,
    `  Corrections 30d: ${detail.correction_count_30d}`,
    ``,
    `*Recent Syncs*`,
    ...detail.recent_sync_runs.slice(0, 3).map((r) => {
      const icon = r.status === 'completed' ? 'OK     ' : r.status === 'failed' ? 'Failed ' : r.status === 'partial' ? 'Partial' : 'Running';
      return `  ${icon} ${ago(r.started_at)} via ${md(r.provider)}${r.events_ingested != null ? ` — ${r.events_ingested} events` : ''}`;
    }),
    ``,
    `Last brief: ${detail.last_brief ? `${md(detail.last_brief.type)} ${ago(detail.last_brief.sent_at)}` : '—'}`,
    `Unacked alerts: ${detail.recent_alerts.filter((a) => !a.acknowledged_at).length}`,
    ...(syncOk ? [] : [
      ``,
      `*Sync errors present. Run /ops errors for details.*`,
    ]),
  ];

  await replyMarkdownSafe(ctx, lines.join('\n'));
}

// /ops operators — compact table of all operators
async function handleOpsOperators(ctx: Context): Promise<void> {
  const operators = await getOpsOperators();
  const lines = [`*All operators (${operators.length})*`, ``];

  for (const op of operators) {
    const icon = op.has_sync_error ? 'Error' : op.active_wallets === 0 ? 'Idle ' : 'OK   ';
    const name = md(op.username ?? op.telegram_id);
    const active = op.last_user_active_at ? ago(op.last_user_active_at) : '—';
    lines.push(`${icon} @${name}  wallets:${op.active_wallets}  active:${active}  unknown:${op.unknown_count}`);
  }

  await replyMarkdownSafe(ctx, lines.join('\n'));
}

export async function handleOps(ctx: Context, user: AuthedUser, args: string[]): Promise<void> {
  if (user.role !== 'admin') {
    await ctx.reply('That one is for admins only.');
    return;
  }

  const sub = args[0] ?? '';

  if (sub === 'errors') {
    await handleOpsErrors(ctx);
  } else if (sub === 'operators' || sub === 'users') {
    await handleOpsOperators(ctx);
  } else if (sub.startsWith('@') || sub.match(/^[0-9a-f-]{8,}/i)) {
    await handleOpsUser(ctx, sub);
  } else {
    await handleOpsOverview(ctx);
  }
}
