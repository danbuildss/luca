import { execSync } from 'child_process';
import { query } from '../db.js';

// ---------------------------------------------------------------------------
// Worker heartbeat
// ---------------------------------------------------------------------------

export async function pingWorkerHeartbeat(): Promise<void> {
  await query(
    `INSERT INTO worker_heartbeat (id, last_ping_at, loop_count)
     VALUES (1, NOW(), 1)
     ON CONFLICT (id) DO UPDATE
       SET last_ping_at = NOW(),
           loop_count   = worker_heartbeat.loop_count + 1`,
    [],
  );
}

export async function getWorkerHeartbeat(): Promise<{ last_ping_at: Date; loop_count: number } | null> {
  const res = await query<{ last_ping_at: Date; loop_count: string }>(
    `SELECT last_ping_at, loop_count FROM worker_heartbeat WHERE id = 1`,
    [],
  );
  if (!res.rows[0]) return null;
  return {
    last_ping_at: res.rows[0].last_ping_at,
    loop_count: Number(res.rows[0].loop_count),
  };
}

// ---------------------------------------------------------------------------
// Wallet staleness
// ---------------------------------------------------------------------------

export type WalletStaleness = {
  wallet_id: string;
  wallet_address: string;
  wallet_label: string | null;
  last_synced_at: Date | null;
  stale_hours: number;
};

export async function getStaleWallets(userId: string, thresholdHours = 4): Promise<WalletStaleness[]> {
  const res = await query<{
    wallet_id: string;
    wallet_address: string;
    wallet_label: string | null;
    last_synced_at: Date | null;
    stale_hours: string;
  }>(
    `SELECT
       w.id AS wallet_id,
       w.address AS wallet_address,
       w.label AS wallet_label,
       wj.last_synced_at,
       EXTRACT(EPOCH FROM (NOW() - COALESCE(wj.last_synced_at, NOW() - INTERVAL '24 hours'))) / 3600 AS stale_hours
     FROM wallets w
     JOIN watch_jobs wj ON wj.wallet_id = w.id
     WHERE w.user_id = $1
       AND w.active = TRUE
       AND wj.status = 'active'
       AND EXTRACT(EPOCH FROM (NOW() - COALESCE(wj.last_synced_at, NOW() - INTERVAL '24 hours'))) / 3600 >= $2`,
    [userId, thresholdHours],
  );

  return res.rows.map((r) => ({
    ...r,
    stale_hours: parseFloat(r.stale_hours),
  }));
}

// ---------------------------------------------------------------------------
// Disk usage
// ---------------------------------------------------------------------------

export type DiskStatus = {
  mountpoint: string;
  used_pct: number;
  avail_gb: number;
};

export function getDiskUsage(): DiskStatus[] {
  try {
    const out = execSync("df -BG / /opt 2>/dev/null | tail -n +2", { encoding: 'utf8', timeout: 5000 });
    const results: DiskStatus[] = [];
    const seen = new Set<string>();

    for (const line of out.trim().split('\n')) {
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      const mountpoint = parts[5];
      if (seen.has(mountpoint)) continue;
      seen.add(mountpoint);

      const usedPct = parseInt(parts[4].replace('%', ''), 10);
      const availGb = parseInt(parts[3].replace('G', ''), 10);
      results.push({ mountpoint, used_pct: usedPct, avail_gb: availGb });
    }
    return results;
  } catch {
    return [];
  }
}
