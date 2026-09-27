// Creator-fee sources (migration 025), for an admin on the server. Reads only: nothing
// here claims, stakes or moves funds, and no Bankr key is used (public data only).
//
//   node dist/scripts/fee-source.js add 0xWallet 0xToken [userId]
//       Start following a token's creator fees paid to a wallet Luca tracks. The pool,
//       fee contract and fee asset are taken from Bankr's public data and checked.
//   node dist/scripts/fee-source.js status
//       What Bankr reports, what the chain shows, and whether they agree.
//   node dist/scripts/fee-source.js share 0xWallet 0xToken on|off [userId]
//       The owner's choice: let other Luca users ask about these fees. They get the fee
//       view only (Bankr's readings, verified claims, the fee wallet's balance of the
//       fee asset), nothing else of the owner's. Off unless turned on.
import { closeDb, query } from '../src/db.js';
import { addFeeSource, feeSourceStatus, setFeeSourceSharing, type FeeSourceStatus } from '../src/fees/sources.js';

const [cmd, a, b, c, d] = process.argv.slice(2);
const usage = 'Usage: node dist/scripts/fee-source.js add 0x<wallet> 0x<token> [userId] | status | share 0x<wallet> 0x<token> on|off [userId]';

const iso = (d: Date): string => new Date(d).toISOString().replace('.000Z', 'Z');

function describe(s: FeeSourceStatus): string[] {
  const src = s.source;
  const lines = [
    `${src.token_symbol} creator fees (${src.token_address}) paid to ${src.wallet_address}`,
    `  pool ${src.pool_id}`,
    `  fee contract ${src.fee_contract}, paid in ${src.fee_asset}`,
    `  Shared with other Luca users: ${src.shared ? 'yes (the fee view only)' : 'no'}`,
  ];
  if (s.reported) {
    lines.push(`  Reported by Bankr at ${iso(s.reported.read_at)}${s.reported_stale ? ' (stale)' : ''}: claimable ${s.reported.claimable} ${src.fee_asset}, claimed ${s.reported.claimed} ${src.fee_asset} in ${s.reported.claim_count} claims`);
  } else {
    lines.push('  Reported by Bankr: no successful reading yet');
  }
  if (s.last_error) lines.push(`  Latest reading failed at ${iso(s.last_error.read_at)}: ${s.last_error.error}`);
  if (s.claimable_change) {
    lines.push(`  Claimable change ${iso(s.claimable_change.since)} to ${iso(s.claimable_change.until)}${s.claimable_change.full_day ? '' : ' (less than a day of readings)'}: ${s.claimable_change.change} ${src.fee_asset}`);
  }
  lines.push(`  Verified on-chain: ${s.verified.count} claims, ${s.verified.total} ${src.fee_asset}${s.verified.last ? `; last ${s.verified.last.amount} on ${iso(s.verified.last.block_time)} (${s.verified.last.hash})` : ''}`);
  if (s.unclear > 0) lines.push(`  Not proven, left unknown: ${s.unclear} transfers`);
  const r = s.reconciliation;
  lines.push(r.status === 'no_reading' ? '  Reconciliation: no Bankr reading to compare'
    : r.status === 'match' ? `  Reconciliation: match (${r.count} claims, ${r.claimed} ${src.fee_asset})`
      : `  Reconciliation: MISMATCH. Bankr reports ${r.reported_claimed} in ${r.reported_count} claims; the chain shows ${r.verified_claimed} in ${r.verified_count} (difference ${r.difference})`);
  return lines;
}

try {
  if (cmd === 'add' && a && b) {
    const res = await addFeeSource({ walletAddress: a, token: b, userId: c });
    if (!res.ok) {
      console.error(res.error);
      process.exitCode = 1;
    } else {
      console.log(res.created ? 'Added.' : 'Already added; nothing changed.');
      for (const s of await feeSourceStatus(res.source.user_id)) {
        if (s.source.id === res.source.id) console.log(describe(s).join('\n'));
      }
    }
  } else if (cmd === 'share' && a && b && (c === 'on' || c === 'off')) {
    const res = await setFeeSourceSharing({ walletAddress: a, token: b, shared: c === 'on', userId: d });
    if (!res.ok) {
      console.error(res.error);
      process.exitCode = 1;
    } else {
      console.log(c === 'on'
        ? 'Shared. Other Luca users who ask about these fees now get the fee view (nothing else of yours).'
        : 'Not shared. Only you see these fees.');
    }
  } else if (cmd === 'status') {
    const users = (await query<{ user_id: string }>(`SELECT DISTINCT user_id FROM fee_sources WHERE active`)).rows;
    if (users.length === 0) console.log('No fee sources.');
    for (const u of users) {
      for (const s of await feeSourceStatus(u.user_id)) console.log(describe(s).join('\n'), '\n');
    }
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
