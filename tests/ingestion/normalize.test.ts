import { describe, it, expect } from 'vitest';
import { normalizeTransfer, parseLogIndex, parseUniqueId } from '../../src/ingestion/normalize.js';
import type { AlchemyTransfer } from '../../src/ingestion/alchemy.js';

const WALLET = '0xabc0000000000000000000000000000000000001';
const OTHER  = '0xdef0000000000000000000000000000000000002';
const WALLET_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID   = '22222222-2222-2222-2222-222222222222';

function makeTransfer(overrides: Partial<AlchemyTransfer> = {}): AlchemyTransfer {
  return {
    blockNum: '0x7a1200',       // 7999008 decimal
    uniqueId: '0xabc123:0x0a',
    hash: '0xdeadbeef',
    from: OTHER,
    to: WALLET,
    value: 500,
    asset: 'USDC',
    category: 'erc20',
    metadata: { blockTimestamp: '2024-01-15T10:30:00Z' },
    rawContract: {
      value: '0x1DCD6500',
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimal: '0x6',
    },
    ...overrides,
  };
}

describe('parseLogIndex', () => {
  it('parses hex log index for erc20 transfers', () => {
    expect(parseLogIndex('0xabc:0x0a')).toBe(10);
    expect(parseLogIndex('0xabc:0x00')).toBe(0);
    expect(parseLogIndex('0xabc:0x1f')).toBe(31);
  });

  it('returns null for native ETH external transfers', () => {
    expect(parseLogIndex('0xabc:external')).toBeNull();
  });

  it('returns null for internal transfers', () => {
    expect(parseLogIndex('0xabc:internal')).toBeNull();
    expect(parseLogIndex('0xabc:internal:3')).toBeNull();
  });

  it('parses Alchemy "<hash>:log:<n>" format (decimal and hex)', () => {
    expect(parseLogIndex('0xabc:log:5')).toBe(5);
    expect(parseLogIndex('0xabc:log:161')).toBe(161);
    expect(parseLogIndex('0xabc:log:0x1f')).toBe(31);
    expect(parseLogIndex('0xabc:log:0')).toBe(0);
  });

  it('parses bare decimal suffix as decimal', () => {
    expect(parseLogIndex('0xabc:10')).toBe(10);
  });

  it('returns null for malformed ids', () => {
    expect(parseLogIndex('0xabc')).toBeNull();
    expect(parseLogIndex('0xabc:log')).toBeNull();
    expect(parseLogIndex('0xabc:log:zz')).toBeNull();
    expect(parseLogIndex('0xabc:garbage')).toBeNull();
    expect(parseLogIndex('')).toBeNull();
  });
});

describe('parseUniqueId', () => {
  it('classifies each known format', () => {
    expect(parseUniqueId('0xabc:log:7')).toEqual({ kind: 'log', index: 7 });
    expect(parseUniqueId('0xabc:0x0a')).toEqual({ kind: 'log', index: 10 });
    expect(parseUniqueId('0xabc:external')).toEqual({ kind: 'external', index: null });
    expect(parseUniqueId('0xabc:internal')).toEqual({ kind: 'internal', index: null });
    expect(parseUniqueId('0xabc:internal:2')).toEqual({ kind: 'internal', index: 2 });
    expect(parseUniqueId('0xabc:internal:0x2')).toEqual({ kind: 'internal', index: 2 });
    expect(parseUniqueId('0xabc:wat')).toEqual({ kind: 'unknown', index: null });
  });
});

describe('source_key', () => {
  it('keys erc20 transfers by log index regardless of uniqueId format', () => {
    const a = normalizeTransfer(makeTransfer({ uniqueId: '0xdeadbeef:log:10' }), WALLET, WALLET_ID, USER_ID);
    const b = normalizeTransfer(makeTransfer({ uniqueId: '0xdeadbeef:0x0a' }), WALLET, WALLET_ID, USER_ID);
    expect(a.event.log_index).toBe(10);
    expect(a.event.source_key).toBe('log:10');
    expect(b.event.source_key).toBe('log:10');
  });

  it('gives distinct keys to two token transfers in the same tx', () => {
    const a = normalizeTransfer(makeTransfer({ uniqueId: '0xdeadbeef:log:3' }), WALLET, WALLET_ID, USER_ID);
    const b = normalizeTransfer(makeTransfer({ uniqueId: '0xdeadbeef:log:4' }), WALLET, WALLET_ID, USER_ID);
    expect(a.event.source_key).not.toBe(b.event.source_key);
  });

  it('keys native external transfers as "external"', () => {
    const t = makeTransfer({ uniqueId: '0xdeadbeef:external', category: 'external', asset: 'ETH' });
    expect(normalizeTransfer(t, WALLET, WALLET_ID, USER_ID).event.source_key).toBe('external');
  });

  it('gives distinct keys to multiple internal transfers in the same tx', () => {
    const base = { category: 'internal' as const, asset: 'ETH', uniqueId: '0xdeadbeef:internal' };
    const a = normalizeTransfer(
      makeTransfer({ ...base, from: OTHER, rawContract: { value: '0x1', address: null, decimal: '0x12' } }),
      WALLET, WALLET_ID, USER_ID,
    );
    const b = normalizeTransfer(
      makeTransfer({ ...base, from: OTHER, rawContract: { value: '0x2', address: null, decimal: '0x12' } }),
      WALLET, WALLET_ID, USER_ID,
    );
    expect(a.event.log_index).toBeNull();
    expect(a.event.source_key).toMatch(/^internal:/);
    expect(a.event.source_key).not.toBe(b.event.source_key);
  });

  it('uses the trace position for internal transfers when present', () => {
    const t = makeTransfer({ category: 'internal', asset: 'ETH', uniqueId: '0xdeadbeef:internal:2' });
    expect(normalizeTransfer(t, WALLET, WALLET_ID, USER_ID).event.source_key).toBe('internal:2');
  });

  it('is stable for the same transfer seen twice (from- and to-address queries)', () => {
    const t = makeTransfer({ category: 'internal', asset: 'ETH', uniqueId: '0xdeadbeef:internal' });
    const a = normalizeTransfer(t, WALLET, WALLET_ID, USER_ID);
    const b = normalizeTransfer({ ...t }, WALLET, WALLET_ID, USER_ID);
    expect(a.event.source_key).toBe(b.event.source_key);
  });
});

describe('normalizeTransfer', () => {
  it('sets direction to "in" when transfer is incoming', () => {
    const t = makeTransfer({ from: OTHER, to: WALLET });
    const { tx, event } = normalizeTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(tx.direction).toBe('in');
    expect(event.direction).toBe('in');
  });

  it('sets direction to "out" when transfer is outgoing', () => {
    const t = makeTransfer({ from: WALLET, to: OTHER });
    const { tx, event } = normalizeTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(tx.direction).toBe('out');
    expect(event.direction).toBe('out');
  });

  it('is case-insensitive for wallet address comparison', () => {
    const t = makeTransfer({ from: WALLET.toUpperCase(), to: OTHER });
    const { tx } = normalizeTransfer(t, WALLET.toLowerCase(), WALLET_ID, USER_ID);
    expect(tx.direction).toBe('out');
  });

  it('parses block number correctly from hex', () => {
    const t = makeTransfer({ blockNum: '0x7a1200' });
    const { tx } = normalizeTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(tx.block_number).toBe(0x7a1200);
  });

  it('parses block_time as Date from ISO timestamp', () => {
    const t = makeTransfer({ metadata: { blockTimestamp: '2024-01-15T10:30:00Z' } });
    const { tx } = normalizeTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(tx.block_time).toBeInstanceOf(Date);
    expect(tx.block_time.toISOString()).toBe('2024-01-15T10:30:00.000Z');
  });

  it('extracts log_index from uniqueId for erc20 transfers', () => {
    const t = makeTransfer({ uniqueId: '0xdeadbeef:0x0a', category: 'erc20' });
    const { event } = normalizeTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(event.log_index).toBe(10);
  });

  it('sets log_index to null for native ETH transfers', () => {
    const t = makeTransfer({ uniqueId: '0xdeadbeef:external', category: 'external' });
    const { event } = normalizeTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(event.log_index).toBeNull();
  });

  it('sets tx_type to "internal" for internal transfers', () => {
    const t = makeTransfer({ category: 'internal', uniqueId: '0xdeadbeef:internal' });
    const { tx } = normalizeTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(tx.tx_type).toBe('internal');
  });

  it('sets tx_type to "transfer" for erc20 and external', () => {
    const erc20 = makeTransfer({ category: 'erc20' });
    const ext = makeTransfer({ category: 'external', uniqueId: '0xdeadbeef:external' });
    expect(normalizeTransfer(erc20, WALLET, WALLET_ID, USER_ID).tx.tx_type).toBe('transfer');
    expect(normalizeTransfer(ext, WALLET, WALLET_ID, USER_ID).tx.tx_type).toBe('transfer');
  });

  it('sets gas fields to null (fetched separately)', () => {
    const { tx } = normalizeTransfer(makeTransfer(), WALLET, WALLET_ID, USER_ID);
    expect(tx.gas_used).toBeNull();
    expect(tx.gas_price).toBeNull();
    expect(tx.gas_usd).toBeNull();
  });

  it('sets price fields to null (classified later)', () => {
    const { event } = normalizeTransfer(makeTransfer(), WALLET, WALLET_ID, USER_ID);
    expect(event.usd_value).toBeNull();
    expect(event.price_source).toBeNull();
    expect(event.price_at).toBeNull();
  });

  it('carries wallet_id and user_id into both rows', () => {
    const { tx, event } = normalizeTransfer(makeTransfer(), WALLET, WALLET_ID, USER_ID);
    expect(tx.wallet_id).toBe(WALLET_ID);
    expect(event.wallet_id).toBe(WALLET_ID);
    expect(event.user_id).toBe(USER_ID);
  });
});
