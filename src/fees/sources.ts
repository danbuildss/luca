import { query } from '../db.js';
import { logger } from '../logger.js';
import { BASE_BNKR, SUPPORTED_TOKENS } from '../ingestion/assets.js';
import { BankrUnavailable, fetchTokenFees, type BankrTokenFees } from './bankr.js';

// A token whose trading fees are paid to one of the operator's wallets (migration 025).
// Luca only reads: it never claims, stakes or moves these fees.

export type FeeSource = {
  id: string;
  user_id: string;
  wallet_id: string;
  wallet_address: string;
  provider: 'bankr';
  token_address: string;
  token_symbol: string;
  pool_id: string;
  fee_contract: string;
  fee_asset: 'BNKR';
  fee_token: string;
  // The owner shares this source's read-only view with other Luca users (migration 026)
  shared: boolean;
};

// Fees are booked only in an asset Luca tracks
const FEE_ASSETS: Record<string, 'BNKR'> = { [BASE_BNKR]: 'BNKR' };

// Readings are hourly; one older than this is no longer "current"
const READ_EVERY_MINUTES = 55;
const STALE_AFTER_MINUTES = 120;
// Bankr reports amounts to 6 decimals
const REPORTED_PRECISION = '0.000001';

const SOURCE_COLUMNS = `fs.id, fs.user_id, fs.wallet_id, LOWER(w.address) AS wallet_address, fs.provider,
  fs.token_address, fs.token_symbol, fs.pool_id, fs.fee_contract, fs.fee_asset, fs.fee_token, fs.shared`;

export async function getFeeSources(userId: string): Promise<FeeSource[]> {
  const res = await query<FeeSource>(
    `SELECT ${SOURCE_COLUMNS} FROM fee_sources fs JOIN wallets w ON w.id = fs.wallet_id
     WHERE fs.user_id = $1 AND fs.active AND w.active ORDER BY fs.created_at`,
    [userId],
  );
  return res.rows;
}

export async function allActiveSources(): Promise<FeeSource[]> {
  const res = await query<FeeSource>(
    `SELECT ${SOURCE_COLUMNS} FROM fee_sources fs JOIN wallets w ON w.id = fs.wallet_id
     WHERE fs.active AND w.active ORDER BY fs.created_at`,
  );
  return res.rows;
}

// What Bankr reports now must be the pool, fee contract, fee asset and wallet the source
// was added with; anything else stops the readings rather than mixing two sources
function mismatch(source: FeeSource, b: BankrTokenFees): string | null {
  const diffs: string[] = [];
  if (b.chain !== 'base') diffs.push(`chain ${b.chain}`);
  if (b.recipient !== source.wallet_address) diffs.push(`fee wallet ${b.recipient}`);
  if (b.poolId !== source.pool_id) diffs.push(`pool ${b.poolId}`);
  if (b.feesContract !== source.fee_contract) diffs.push(`fee contract ${b.feesContract}`);
  if (b.feeToken !== source.fee_token) diffs.push(`fee token ${b.feeToken}`);
  return diffs.length > 0 ? `Bankr now reports a different ${diffs.join(', ')} for ${source.token_symbol}; readings are paused until an admin checks it` : null;
}

export async function recordReading(source: FeeSource, fetch = fetchTokenFees): Promise<void> {
  try {
    const b = await fetch(source.token_address);
    const wrong = mismatch(source, b);
    if (wrong) {
      await query(
        `INSERT INTO fee_source_readings (fee_source_id, status, error, raw) VALUES ($1, 'error', $2, $3)`,
        [source.id, wrong, JSON.stringify(b.raw)],
      );
      logger.warn({ feeSourceId: source.id, wrong }, 'Fee source changed at Bankr');
      return;
    }
    await query(
      `INSERT INTO fee_source_readings (fee_source_id, status, claimable, claimed, claim_count, raw)
       VALUES ($1, 'ok', $2, $3, $4, $5)`,
      [source.id, b.claimable, b.claimed, b.claimCount, JSON.stringify(b.raw)],
    );
  } catch (err) {
    const message = err instanceof BankrUnavailable ? err.message : 'Reading Bankr failed';
    await query(
      `INSERT INTO fee_source_readings (fee_source_id, status, error) VALUES ($1, 'error', $2)`,
      [source.id, message],
    );
    logger.warn({ err, feeSourceId: source.id }, 'Fee source reading failed');
  }
}

// Hourly: every active source whose last attempt is older than an hour
export async function readDueFeeSources(fetch = fetchTokenFees): Promise<number> {
  const due = await query<{ id: string }>(
    `SELECT fs.id FROM fee_sources fs
     WHERE fs.active AND NOT EXISTS (
       SELECT 1 FROM fee_source_readings r
       WHERE r.fee_source_id = fs.id AND r.read_at > NOW() - ($1::int * INTERVAL '1 minute'))`,
    [READ_EVERY_MINUTES],
  );
  const ids = new Set(due.rows.map((r) => r.id));
  const sources = (await allActiveSources()).filter((s) => ids.has(s.id));
  for (const s of sources) await recordReading(s, fetch);
  return sources.length;
}

export type AddFeeSourceResult =
  | { ok: true; source: FeeSource; created: boolean }
  | { ok: false; error: string };

// Adds a token's creator fees for a wallet Luca already tracks. Everything stored comes
// from Bankr's public data and is checked: the fees must be paid to this wallet, on Base,
// in an asset Luca tracks.
export async function addFeeSource(
  params: { walletAddress: string; token: string; userId?: string },
  fetch = fetchTokenFees,
): Promise<AddFeeSourceResult> {
  const address = params.walletAddress.toLowerCase();
  const token = params.token.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address) || !/^0x[0-9a-f]{40}$/.test(token)) {
    return { ok: false, error: 'Both the wallet and the token must be 0x addresses' };
  }
  const wallets = (await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM wallets WHERE LOWER(address) = $1 AND chain = 'base' AND active
       AND ($2::uuid IS NULL OR user_id = $2::uuid)`,
    [address, params.userId ?? null],
  )).rows;
  if (wallets.length === 0) return { ok: false, error: `Luca is not tracking ${address} on Base${params.userId ? ' for that user' : ''}` };
  if (wallets.length > 1) {
    return { ok: false, error: `${address} is tracked by ${wallets.length} users; pass the user id (${wallets.map((w) => w.user_id).join(', ')})` };
  }
  const wallet = wallets[0];

  let b: BankrTokenFees;
  try {
    b = await fetch(token);
  } catch (err) {
    return { ok: false, error: err instanceof BankrUnavailable ? err.message : 'Reading Bankr failed' };
  }
  if (b.chain !== 'base') return { ok: false, error: `Bankr reports these fees on ${b.chain}, not Base` };
  if (b.recipient !== address) return { ok: false, error: `Bankr pays these fees to ${b.recipient}, not ${address}` };
  const feeAsset = FEE_ASSETS[b.feeToken];
  if (!feeAsset) return { ok: false, error: `These fees are paid in ${b.feeLabel} (${b.feeToken}), which Luca does not track` };

  const inserted = await query<{ id: string }>(
    `INSERT INTO fee_sources (user_id, wallet_id, provider, token_address, token_symbol, pool_id, fee_contract, fee_asset, fee_token)
     VALUES ($1, $2, 'bankr', $3, $4, $5, $6, $7, $8)
     ON CONFLICT (wallet_id, token_address) DO NOTHING RETURNING id`,
    [wallet.user_id, wallet.id, token, b.symbol.slice(0, 32), b.poolId, b.feesContract, feeAsset, b.feeToken],
  );
  const source = (await query<FeeSource>(
    `SELECT ${SOURCE_COLUMNS} FROM fee_sources fs JOIN wallets w ON w.id = fs.wallet_id
     WHERE fs.wallet_id = $1 AND fs.token_address = $2`,
    [wallet.id, token],
  )).rows[0];
  if (inserted.rows.length > 0) await recordReading(source, () => Promise.resolve(b));
  return { ok: true, source, created: inserted.rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Status: what Bankr reports, what the chain shows, and whether they agree
// ---------------------------------------------------------------------------

export type Reading = { claimable: string; claimed: string; claim_count: number; read_at: Date };

export type FeeSourceStatus = {
  source: FeeSource;
  // Reported by Bankr: the latest successful reading
  reported: Reading | null;
  reported_stale: boolean;
  // The latest attempt, when it failed (Luca still shows the last good reading and its time)
  last_error: { error: string; read_at: Date } | null;
  // Change in reported claimable fees between readings (not "earned": a claim lowers it)
  claimable_change: { since: Date; until: Date; change: string; full_day: boolean } | null;
  // Verified on-chain: fee-asset transfers into the fee wallet whose receipts tie them to
  // this pool (src/fees/claims.ts), within the history Luca holds for the wallet
  // usd_when_claimed: the claims' value at the time of each claim; null unless all are priced
  verified: { count: number; total: string; usd_when_claimed: number | null; last: { hash: string; block_time: Date; amount: string } | null };
  // Fee-contract transfers whose evidence was not enough; these stay unknown
  unclear: number;
  reconciliation:
    | { status: 'no_reading' }
    | { status: 'match'; claimed: string; count: number }
    | { status: 'mismatch'; reported_claimed: string; reported_count: number; verified_claimed: string; verified_count: number; difference: string };
};

// Sources other owners share with everyone (never the viewer's own)
export async function getSharedFeeSources(viewerUserId: string): Promise<FeeSource[]> {
  const res = await query<FeeSource>(
    `SELECT ${SOURCE_COLUMNS} FROM fee_sources fs JOIN wallets w ON w.id = fs.wallet_id
     WHERE fs.shared AND fs.active AND w.active AND fs.user_id <> $1 ORDER BY fs.created_at`,
    [viewerUserId],
  );
  return res.rows;
}

export type SetSharingResult = { ok: true; source: FeeSource } | { ok: false; error: string };

// The owner's switch, run by an admin on the server
export async function setFeeSourceSharing(params: { walletAddress: string; token: string; shared: boolean; userId?: string }): Promise<SetSharingResult> {
  const matches = (await query<{ id: string }>(
    `SELECT fs.id FROM fee_sources fs JOIN wallets w ON w.id = fs.wallet_id
     WHERE LOWER(w.address) = $1 AND fs.token_address = $2 AND ($3::uuid IS NULL OR fs.user_id = $3::uuid)`,
    [params.walletAddress.toLowerCase(), params.token.toLowerCase(), params.userId ?? null],
  )).rows;
  if (matches.length === 0) return { ok: false, error: 'No fee source for that wallet and token' };
  if (matches.length > 1) return { ok: false, error: 'More than one user follows these fees; pass the user id' };
  await query(`UPDATE fee_sources SET shared = $2, shared_changed_at = NOW() WHERE id = $1`, [matches[0].id, params.shared]);
  const source = (await query<FeeSource>(
    `SELECT ${SOURCE_COLUMNS} FROM fee_sources fs JOIN wallets w ON w.id = fs.wallet_id WHERE fs.id = $1`, [matches[0].id],
  )).rows[0];
  return { ok: true, source };
}

export async function feeSourceStatus(userId: string): Promise<FeeSourceStatus[]> {
  return statusOf(await getFeeSources(userId));
}

// The view other users get of what owners share: built from the fee tables only
export async function sharedFeeSourceStatus(viewerUserId: string): Promise<FeeSourceStatus[]> {
  return statusOf(await getSharedFeeSources(viewerUserId));
}

// Every figure is scoped to the source's own owner and wallet
async function statusOf(sources: FeeSource[]): Promise<FeeSourceStatus[]> {
  const out: FeeSourceStatus[] = [];
  for (const source of sources) {
    const userId = source.user_id;
    const latestOk = (await query<Reading>(
      `SELECT trim_scale(claimable)::text AS claimable, trim_scale(claimed)::text AS claimed, claim_count, read_at
       FROM fee_source_readings WHERE fee_source_id = $1 AND status = 'ok'
       ORDER BY read_at DESC LIMIT 1`,
      [source.id],
    )).rows[0] ?? null;
    const latest = (await query<{ status: string; error: string | null; read_at: Date }>(
      `SELECT status, error, read_at FROM fee_source_readings WHERE fee_source_id = $1 ORDER BY read_at DESC LIMIT 1`,
      [source.id],
    )).rows[0];
    const stale = latestOk
      ? (await query<{ stale: boolean }>(
        `SELECT $1::timestamptz < NOW() - ($2::int * INTERVAL '1 minute') AS stale`, [latestOk.read_at, STALE_AFTER_MINUTES],
      )).rows[0].stale
      : false;

    let claimableChange: FeeSourceStatus['claimable_change'] = null;
    if (latestOk) {
      // The reading a day before the latest one, else the earliest there is
      const base = (await query<{ claimable: string; read_at: Date; full_day: boolean }>(
        `SELECT trim_scale(claimable)::text AS claimable, read_at, TRUE AS full_day FROM fee_source_readings
         WHERE fee_source_id = $1 AND status = 'ok' AND read_at <= $2::timestamptz - INTERVAL '24 hours'
         ORDER BY read_at DESC LIMIT 1`,
        [source.id, latestOk.read_at],
      )).rows[0] ?? (await query<{ claimable: string; read_at: Date; full_day: boolean }>(
        `SELECT trim_scale(claimable)::text AS claimable, read_at, FALSE AS full_day FROM fee_source_readings
         WHERE fee_source_id = $1 AND status = 'ok' AND read_at < $2::timestamptz
         ORDER BY read_at ASC LIMIT 1`,
        [source.id, latestOk.read_at],
      )).rows[0];
      if (base) {
        const change = (await query<{ d: string }>(`SELECT trim_scale($1::numeric - $2::numeric)::text AS d`, [latestOk.claimable, base.claimable])).rows[0].d;
        claimableChange = { since: base.read_at, until: latestOk.read_at, change, full_day: base.full_day };
      }
    }

    // Exact on-chain amounts (raw integer units), not the rounded decimal
    const decimals = SUPPORTED_TOKENS[source.fee_token]?.decimals ?? 18;
    const exact = `COALESCE(ne.raw_amount / (10::numeric ^ $3::int), ne.amount)`;
    const verified = (await query<{ count: number; total: string; usd: string | null; priced: number }>(
      `SELECT COUNT(*)::int AS count, trim_scale(COALESCE(SUM(${exact}), 0))::text AS total,
              SUM(ne.usd_value)::text AS usd, COUNT(ne.usd_value)::int AS priced
       FROM fee_claim_checks k JOIN normalized_events ne ON ne.id = k.event_id
       WHERE k.fee_source_id = $1 AND k.verdict = 'claim' AND ne.user_id = $2`,
      [source.id, userId, decimals],
    )).rows[0];
    const last = (await query<{ hash: string; block_time: Date; amount: string }>(
      `SELECT ne.hash, ne.block_time, trim_scale(${exact})::text AS amount
       FROM fee_claim_checks k JOIN normalized_events ne ON ne.id = k.event_id
       WHERE k.fee_source_id = $1 AND k.verdict = 'claim' AND ne.user_id = $2
       ORDER BY ne.block_time DESC LIMIT 1`,
      [source.id, userId, decimals],
    )).rows[0] ?? null;
    const unclear = (await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM fee_claim_checks k JOIN normalized_events ne ON ne.id = k.event_id
       WHERE k.fee_source_id = $1 AND k.verdict = 'unclear' AND ne.user_id = $2`,
      [source.id, userId],
    )).rows[0].n;

    let reconciliation: FeeSourceStatus['reconciliation'] = { status: 'no_reading' };
    if (latestOk) {
      const cmp = (await query<{ diff: string; same: boolean }>(
        `SELECT trim_scale($1::numeric - $2::numeric)::text AS diff, ABS($1::numeric - $2::numeric) <= $3::numeric AS same`,
        [latestOk.claimed, verified.total, REPORTED_PRECISION],
      )).rows[0];
      reconciliation = cmp.same && latestOk.claim_count === verified.count
        ? { status: 'match', claimed: latestOk.claimed, count: verified.count }
        : {
          status: 'mismatch', reported_claimed: latestOk.claimed, reported_count: latestOk.claim_count,
          verified_claimed: verified.total, verified_count: verified.count, difference: cmp.diff,
        };
    }

    out.push({
      source,
      reported: latestOk,
      reported_stale: stale,
      last_error: latest && latest.status === 'error' ? { error: latest.error ?? 'Reading Bankr failed', read_at: latest.read_at } : null,
      claimable_change: claimableChange,
      verified: {
        count: verified.count,
        total: verified.total,
        usd_when_claimed: verified.count > 0 && verified.priced === verified.count && verified.usd !== null ? parseFloat(verified.usd) : null,
        last,
      },
      unclear,
      reconciliation,
    });
  }
  return out;
}
