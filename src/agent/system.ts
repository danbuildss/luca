import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_PROMPT = readFileSync(join(__dirname, '../../../prompts/system.md'), 'utf8');

type WalletContext = {
  address: string;
  label: string | null;
  chain: string;
  roles: string[];
};

type CounterpartyContext = {
  address: string;
  name: string | null;
  label: string;
};

async function getUserWallets(userId: string): Promise<WalletContext[]> {
  const res = await query<{ address: string; label: string | null; chain: string; roles: string }>(
    `SELECT w.address, w.label, w.chain,
            COALESCE(string_agg(wr.role, ', ' ORDER BY wr.role), '') AS roles
     FROM wallets w
     LEFT JOIN wallet_roles wr ON wr.wallet_id = w.id
     WHERE w.user_id = $1 AND w.active = TRUE
     GROUP BY w.address, w.label, w.chain
     ORDER BY w.created_at`,
    [userId],
  );
  return res.rows.map((r) => ({
    ...r,
    roles: r.roles ? r.roles.split(', ') : [],
  }));
}

async function getNamedCounterparties(userId: string): Promise<CounterpartyContext[]> {
  const res = await query<CounterpartyContext>(
    `SELECT address, name, label
     FROM counterparty_rules
     WHERE user_id = $1 AND name IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 30`,
    [userId],
  );
  return res.rows;
}

export async function buildSystemPrompt(userId: string): Promise<string> {
  const [wallets, counterparties] = await Promise.all([
    getUserWallets(userId),
    getNamedCounterparties(userId),
  ]);

  const parts: string[] = [BASE_PROMPT];

  if (wallets.length > 0) {
    const walletLines = wallets.map((w) => {
      const roles = w.roles.length > 0 ? ` [${w.roles.join(', ')}]` : '';
      const label = w.label ? ` (${w.label})` : '';
      return `- ${w.address}${label} on ${w.chain}${roles}`;
    });
    parts.push(`\n## Your Operator's Wallets\n\n${walletLines.join('\n')}`);
  } else {
    parts.push('\n## Your Operator\'s Wallets\n\nNo wallets registered yet. Ask the operator for their wallet address to get started.');
  }

  if (counterparties.length > 0) {
    const cpLines = counterparties.map(
      (c) => `- ${c.address}: ${c.name ?? 'unnamed'} (${c.label})`,
    );
    parts.push(`\n## Known Counterparties\n\n${cpLines.join('\n')}`);
  }

  parts.push('\n## Today\n\nDate: ' + new Date().toISOString().split('T')[0]);

  return parts.join('\n');
}
