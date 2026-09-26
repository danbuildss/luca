import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({ query: vi.fn(() => Promise.resolve({ rows: [] })), pool: { connect: vi.fn() } }));

import * as db from '../../src/db.js';
import { prepareWriteAction, executeTool } from '../../src/agent/tools.js';

const BASE = '0x' + 'a'.repeat(40);

describe('registering a wallet: Base only', () => {
  it('refuses a Solana wallet before any Confirm button is shown', async () => {
    const r = await prepareWriteAction('u1', 'register_wallet', { address: 'So11111111111111111111111111111111111111112', chain: 'solana' });
    expect(r).toEqual({ ok: false, error: 'Luca only tracks wallets on Base.' });
  });

  it('refuses an address that is not a Base address', async () => {
    const r = await prepareWriteAction('u1', 'register_wallet', { address: 'not-an-address' });
    expect(r.ok).toBe(false);
  });

  it('accepts a Base address', async () => {
    expect(await prepareWriteAction('u1', 'register_wallet', { address: BASE })).toEqual({ ok: true, args: { address: BASE } });
  });

  it('the write itself also refuses another chain and stores nothing', async () => {
    const r = await executeTool('u1', 'register_wallet', { address: BASE, chain: 'solana' });
    expect(r).toEqual({ error: 'Luca only tracks wallets on Base.' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
