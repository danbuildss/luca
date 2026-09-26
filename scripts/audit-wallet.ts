// Read-only Phase 1 check on a real wallet: traces every transaction any source knows
// through every layer Luca keeps and reports what was lost where.
//
//   node dist/scripts/audit-wallet.js 0xYourWallet
//
// It reads Alchemy, Blockscout and the database; it never writes.
import { config } from '../src/config.js';
import { closeDb } from '../src/db.js';
import { auditWallet, describeAudit } from '../src/ledger/audit.js';

const address = process.argv[2];
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error('Usage: node dist/scripts/audit-wallet.js 0x<wallet address>');
  process.exit(1);
}
if (!config.ALCHEMY_API_KEY) {
  console.error('ALCHEMY_API_KEY is not set; the audit needs it to read the chain.');
  process.exit(1);
}

try {
  const audit = await auditWallet(address, config.ALCHEMY_API_KEY, {
    pauseMs: 250,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) process.stderr.write(`traced ${done}/${total}\n`);
    },
  });
  console.log(describeAudit(audit).join('\n'));
  process.exitCode = audit.lost.length > 0 ? 2 : 0;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
