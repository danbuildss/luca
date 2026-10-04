import { query } from '../db.js';
import { formatAddress } from '../telegram/format.js';
import { getWorkerHeartbeat, getStaleWallets, getDiskUsage } from './monitor.js';

// Alerts about Luca itself (its worker, its disk, a wallet it has not read for hours) go
// to admins only, never to an operator: an operator never hears about our server. An
// admin is told which operator a wallet belongs to. Admins get these at any hour
// (src/notify/quiet-hours.ts).

type HealthAlertType = 'worker_stale' | 'wallet_stale' | 'disk_pressure';

type HealthAlert = {
  userId: string;
  type: HealthAlertType;
  message: string;
  evidence: Record<string, unknown>;
  dedupKey: string;
};

async function insertHealthAlert(alert: HealthAlert): Promise<boolean> {
  const res = await query<{ id: string }>(
    `INSERT INTO alerts (user_id, type, message, evidence, dedup_key, certainty)
     VALUES ($1, $2, $3, $4, $5, 'data_issue')
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [alert.userId, alert.type, alert.message, JSON.stringify(alert.evidence), alert.dedupKey],
  );
  return res.rows.length > 0;
}

export async function adminUserIds(): Promise<string[]> {
  return (await query<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at`, [])).rows.map((r) => r.id);
}

// How an admin is told whose wallet it is: "@nfteague's", or "Your" for their own
export async function ownerWords(subjectUserId: string, adminId: string): Promise<string> {
  if (subjectUserId === adminId) return 'Your';
  const u = (await query<{ telegram_username: string | null }>(
    `SELECT telegram_username FROM users WHERE id = $1`, [subjectUserId],
  )).rows[0];
  return u?.telegram_username ? `@${u.telegram_username}'s` : "An operator's";
}

// ---------------------------------------------------------------------------
// Worker heartbeat staleness — dedup key rolls every hour. Run by the Telegram process,
// which also sends it (the worker cannot send anything while it is stopped).
// ---------------------------------------------------------------------------
export async function detectWorkerStale(): Promise<number> {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH

  const hb = await getWorkerHeartbeat();
  const staleMinutes = hb ? (now.getTime() - new Date(hb.last_ping_at).getTime()) / 60_000 : 999;
  if (staleMinutes < 5) return 0;

  const sinceStr = hb
    ? `Its last check-in was ${Math.round(staleMinutes)} minutes ago`
    : 'It has never checked in';
  const message = [
    `Luca's worker has stopped`,
    `${sinceStr}, so wallets are not syncing and alerts are paused.`,
  ].join('\n');

  let count = 0;
  for (const adminId of await adminUserIds()) {
    const inserted = await insertHealthAlert({
      userId: adminId,
      type: 'worker_stale',
      message,
      evidence: { stale_minutes: staleMinutes, last_ping_at: hb?.last_ping_at ?? null },
      dedupKey: `worker_stale:${adminId}:${hourKey}`,
    });
    if (inserted) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Wallet sync staleness — per operator's wallets, told to admins; dedup rolls every 4 hours
// ---------------------------------------------------------------------------
export async function detectStaleWallets(userId: string): Promise<number> {
  const stale = await getStaleWallets(userId, 4);
  if (stale.length === 0) return 0;

  const now = new Date();
  const windowKey = `${now.toISOString().slice(0, 10)}_${Math.floor(now.getUTCHours() / 4)}`;

  let count = 0;
  for (const adminId of await adminUserIds()) {
    const owner = await ownerWords(userId, adminId);
    for (const w of stale) {
      const walletHint = w.wallet_label
        ? `${formatAddress(w.wallet_address)} (${w.wallet_label})`
        : formatAddress(w.wallet_address);
      const lastStr = w.last_synced_at
        ? `last synced ${Math.round(w.stale_hours)} hours ago`
        : 'has never synced';

      const inserted = await insertHealthAlert({
        userId: adminId,
        type: 'wallet_stale',
        message: [`Wallet sync is behind`, `${owner} wallet ${walletHint} ${lastStr}.`].join('\n'),
        evidence: {
          owner_user_id: userId,
          wallet_id: w.wallet_id,
          stale_hours: w.stale_hours,
          last_synced_at: w.last_synced_at,
        },
        dedupKey: `wallet_stale:${adminId}:${w.wallet_id}:${windowKey}`,
      });
      if (inserted) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Disk pressure — the server's, told to admins once; dedup rolls every 12 hours
// ---------------------------------------------------------------------------
export async function detectDiskPressure(): Promise<number> {
  const disks = getDiskUsage().filter((d) => d.used_pct >= 80);
  if (disks.length === 0) return 0;
  const now = new Date();
  const windowKey = `${now.toISOString().slice(0, 10)}_${Math.floor(now.getUTCHours() / 12)}`;

  let count = 0;
  for (const adminId of await adminUserIds()) {
    for (const disk of disks) {
      const message = [
        `Server disk is ${disk.used_pct >= 90 ? 'nearly full' : 'filling up'}`,
        `${disk.mountpoint} is ${disk.used_pct}% used with ${disk.avail_gb} GB free. ${
          disk.used_pct >= 90 ? 'Clear old logs or backups soon.' : 'Worth keeping an eye on.'}`,
      ].join('\n');

      const inserted = await insertHealthAlert({
        userId: adminId,
        type: 'disk_pressure',
        message,
        evidence: { mountpoint: disk.mountpoint, used_pct: disk.used_pct, avail_gb: disk.avail_gb },
        dedupKey: `disk_pressure:${adminId}:${disk.mountpoint}:${windowKey}`,
      });
      if (inserted) count++;
    }
  }
  return count;
}
