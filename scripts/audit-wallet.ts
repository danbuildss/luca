// Engineering fallback for the chat check ("are my books complete?"): traces every
// transaction any source knows through every layer Luca keeps and reports what did not
// reach the books, per layer. Read-only.
//
//   node dist/scripts/audit-wallet.js              every active wallet
//   node dist/scripts/audit-wallet.js 0xWallet     one wallet
//   node dist/scripts/audit-wallet.js 0xWallet 1   one wallet, last day only
import { config } from '../src/config.js';
import { closeDb, query } from '../src/db.js';
import { auditWallet, describeAudit } from '../src/ledger/audit.js';

const address = process.argv[2];
const days = process.argv[3] ? Number(process.argv[3]) : undefined;
if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error('Usage: node dist/scripts/audit-wallet.js [0x<wallet address> [days]]');
  process.exit(1);
}
if (!config.ALCHEMY_API_KEY) {
  console.error('ALCHEMY_API_KEY is not set; the audit needs it to read the chain.');
  process.exit(1);
}

try {
  const wallets = address
    ? [address]
    : (await query<{ address: string }>(
        `SELECT address FROM wallets WHERE active = TRUE AND chain = 'base' ORDER BY created_at`,
      )).rows.map((r) => r.address);
  let lost = 0;
  for (const w of wallets) {
    const audit = await auditWallet(w, config.ALCHEMY_API_KEY, {
      days,
      pauseMs: 250,
      onProgress: (done, total) => {
        if (done % 10 === 0 || done === total) process.stderr.write(`${w}: traced ${done}/${total}\n`);
      },
    });
    console.log(describeAudit(audit).join('\n'), '\n');
    lost += audit.lost.length;
  }
  process.exitCode = lost > 0 ? 2 : 0;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
