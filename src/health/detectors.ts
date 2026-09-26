import { query } from '../db.js';
import { formatAddress } from '../telegram/format.js';
import { getWorkerHeartbeat, getStaleWallets, getDiskUsage } from './monitor.js';

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

// ---------------------------------------------------------------------------
// Worker heartbeat staleness — dedup key rolls every hour
// ---------------------------------------------------------------------------
export async function detectWorkerStale(userId: string): Promise<number> {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const dedupKey = `worker_stale:${userId}:${hourKey}`;

  const hb = await getWorkerHeartbeat();

  let staleMinutes: number;
  if (!hb) {
    staleMinutes = 999;
  } else {
    staleMinutes = (now.getTime() - new Date(hb.last_ping_at).getTime()) / 60_000;
  }

  if (staleMinutes < 5) return 0;

  const sinceStr = hb
    ? `Its last check-in was ${Math.round(staleMinutes)} minutes ago`
    : 'It has never checked in';

  const message = [
    `Luca's worker has stopped`,
    `${sinceStr}, so wallets are not syncing and alerts are paused.`,
  ].join('\n');

  const inserted = await insertHealthAlert({
    userId,
    type: 'worker_stale',
    message,
    evidence: { stale_minutes: staleMinutes, last_ping_at: hb?.last_ping_at ?? null },
    dedupKey,
  });
  return inserted ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Wallet sync staleness — dedup key rolls every 4 hours
// ---------------------------------------------------------------------------
export async function detectStaleWallets(userId: string): Promise<number> {
  const stale = await getStaleWallets(userId, 4);
  if (stale.length === 0) return 0;

  const now = new Date();
  const windowKey = `${now.toISOString().slice(0, 10)}_${Math.floor(now.getUTCHours() / 4)}`;

  let count = 0;
  for (const w of stale) {
    const dedupKey = `wallet_stale:${w.wallet_id}:${windowKey}`;
    const walletHint = w.wallet_label
      ? `${formatAddress(w.wallet_address)} (${w.wallet_label})`
      : formatAddress(w.wallet_address);

    const lastStr = w.last_synced_at
      ? `last synced ${Math.round(w.stale_hours)} hours ago`
      : 'has never synced';

    const message = [`Wallet sync is behind`, `${walletHint} ${lastStr}.`].join('\n');

    const inserted = await insertHealthAlert({
      userId,
      type: 'wallet_stale',
      message,
      evidence: {
        wallet_id: w.wallet_id,
        stale_hours: w.stale_hours,
        last_synced_at: w.last_synced_at,
      },
      dedupKey,
    });
    if (inserted) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Disk pressure — dedup key rolls every 12 hours
// ---------------------------------------------------------------------------
export async function detectDiskPressure(userId: string): Promise<number> {
  const disks = getDiskUsage();
  const now = new Date();
  const windowKey = `${now.toISOString().slice(0, 10)}_${Math.floor(now.getUTCHours() / 12)}`;

  let count = 0;
  for (const disk of disks) {
    if (disk.used_pct < 80) continue;

    const dedupKey = `disk_pressure:${disk.mountpoint}:${windowKey}`;

    const message = [
      `Server disk is ${disk.used_pct >= 90 ? 'nearly full' : 'filling up'}`,
      `${disk.mountpoint} is ${disk.used_pct}% used with ${disk.avail_gb} GB free. ${
        disk.used_pct >= 90 ? 'Clear old logs or backups soon.' : 'Worth keeping an eye on.'}`,
    ].join('\n');

    const inserted = await insertHealthAlert({
      userId,
      type: 'disk_pressure',
      message,
      evidence: { mountpoint: disk.mountpoint, used_pct: disk.used_pct, avail_gb: disk.avail_gb },
      dedupKey,
    });
    if (inserted) count++;
  }
  return count;
}
