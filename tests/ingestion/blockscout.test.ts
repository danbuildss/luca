import { describe, it, expect } from 'vitest';
import {
  normalizeTokenTransfer,
  normalizeNativeTx,
  isIngestibleNativeTx,
  type BlockscoutTokenTransfer,
  type BlockscoutTx,
} from '../../src/ingestion/blockscout.js';

const WALLET = '0xabc0000000000000000000000000000000000001';
const OTHER  = '0xdef0000000000000000000000000000000000002';
const WALLET_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID   = '22222222-2222-2222-2222-222222222222';

function makeTokenTransfer(overrides: Partial<BlockscoutTokenTransfer> = {}): BlockscoutTokenTransfer {
  return {
    block_number: 12345678,
    from: { hash: OTHER },
    to: { hash: WALLET },
    token: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: '6',
      symbol: 'USDC',
    },
    total: { decimals: '6', value: '500000000' }, // 500 USDC
    tx_hash: '0xdeadbeef',
    timestamp: '2024-01-15T10:30:00.000000Z',
    log_index: '10',
    ...overrides,
  };
}

function makeNativeTx(overrides: Partial<BlockscoutTx> = {}): BlockscoutTx {
  return {
    hash: '0xcafebabe',
    block: 12345678,
    timestamp: '2024-01-15T10:30:00.000000Z',
    from: { hash: WALLET },
    to: { hash: OTHER },
    value: '100000000000000000', // 0.1 ETH in wei
    gas_used: '21000',
    gas_price: '1000000000', // 1 Gwei in wei
    status: 'ok',
    ...overrides,
  };
}

describe('normalizeTokenTransfer', () => {
  it('sets direction to "in" when transfer is incoming', () => {
    const { tx, event } = normalizeTokenTransfer(makeTokenTransfer(), WALLET, WALLET_ID, USER_ID);
    expect(tx.direction).toBe('in');
    expect(event.direction).toBe('in');
  });

  it('sets direction to "out" when transfer is outgoing', () => {
    const t = makeTokenTransfer({ from: { hash: WALLET }, to: { hash: OTHER } });
    const { tx } = normalizeTokenTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(tx.direction).toBe('out');
  });

  it('divides raw value by decimals correctly', () => {
    // 500000000 raw / 10^6 = 500 USDC
    const { tx } = normalizeTokenTransfer(makeTokenTransfer(), WALLET, WALLET_ID, USER_ID);
    expect(tx.amount).toBe(500);
  });

  it('handles tokens with 18 decimals', () => {
    const t = makeTokenTransfer({
      token: { address: '0x4200000000000000000000000000000000000006', decimals: '18', symbol: 'WETH' },
      total: { decimals: '18', value: '1000000000000000000' }, // 1 WETH
    });
    const { tx } = normalizeTokenTransfer(t, WALLET, WALLET_ID, USER_ID);
    expect(tx.amount).toBeCloseTo(1, 10);
  });

  it('parses log_index as integer', () => {
    const { event } = normalizeTokenTransfer(makeTokenTransfer({ log_index: '42' }), WALLET, WALLET_ID, USER_ID);
    expect(event.log_index).toBe(42);
  });

  it('sets log_index to null when absent', () => {
    const { event } = normalizeTokenTransfer(makeTokenTransfer({ log_index: null }), WALLET, WALLET_ID, USER_ID);
    expect(event.log_index).toBeNull();
  });

  it('sets asset to token symbol', () => {
    const { tx } = normalizeTokenTransfer(makeTokenTransfer(), WALLET, WALLET_ID, USER_ID);
    expect(tx.asset).toBe('USDC');
  });

  it('sets chain to "base"', () => {
    const { tx, event } = normalizeTokenTransfer(makeTokenTransfer(), WALLET, WALLET_ID, USER_ID);
    expect(tx.chain).toBe('base');
    expect(event.chain).toBe('base');
  });

  it('gas fields are null (token transfers do not carry gas)', () => {
    const { tx } = normalizeTokenTransfer(makeTokenTransfer(), WALLET, WALLET_ID, USER_ID);
    expect(tx.gas_used).toBeNull();
    expect(tx.gas_price).toBeNull();
    expect(tx.gas_usd).toBeNull();
  });
});

describe('normalizeNativeTx', () => {
  it('converts wei to ETH correctly', () => {
    // 100000000000000000 wei = 0.1 ETH
    const { tx } = normalizeNativeTx(makeNativeTx(), WALLET, WALLET_ID, USER_ID);
    expect(tx.amount).toBeCloseTo(0.1, 10);
  });

  it('sets asset to "ETH"', () => {
    const { tx } = normalizeNativeTx(makeNativeTx(), WALLET, WALLET_ID, USER_ID);
    expect(tx.asset).toBe('ETH');
  });

  it('sets direction to "out" for outgoing native tx', () => {
    const { tx } = normalizeNativeTx(makeNativeTx(), WALLET, WALLET_ID, USER_ID);
    expect(tx.direction).toBe('out');
  });

  it('converts gas_price from wei to Gwei', () => {
    // 1000000000 wei = 1 Gwei
    const { tx } = normalizeNativeTx(makeNativeTx(), WALLET, WALLET_ID, USER_ID);
    expect(tx.gas_price).toBeCloseTo(1, 5);
  });

  it('sets gas_used from string', () => {
    const { tx } = normalizeNativeTx(makeNativeTx(), WALLET, WALLET_ID, USER_ID);
    expect(tx.gas_used).toBe(21000);
  });

  it('sets log_index to null (native transfers have no logs)', () => {
    const { event } = normalizeNativeTx(makeNativeTx(), WALLET, WALLET_ID, USER_ID);
    expect(event.log_index).toBeNull();
  });

  it('handles null gas fields gracefully', () => {
    const t = makeNativeTx({ gas_used: null, gas_price: null });
    const { tx } = normalizeNativeTx(t, WALLET, WALLET_ID, USER_ID);
    expect(tx.gas_used).toBeNull();
    expect(tx.gas_price).toBeNull();
  });

  it('uses source_key "external" (same as Alchemy native transfers)', () => {
    const { event } = normalizeNativeTx(makeNativeTx(), WALLET, WALLET_ID, USER_ID);
    expect(event.source_key).toBe('external');
  });
});

describe('source_key for token transfers', () => {
  it('keys by log index, matching the Alchemy key for the same transfer', () => {
    const { event } = normalizeTokenTransfer(makeTokenTransfer({ log_index: '10' }), WALLET, WALLET_ID, USER_ID);
    expect(event.source_key).toBe('log:10');
  });

  it('falls back to a transfer fingerprint when log_index is absent', () => {
    const a = normalizeTokenTransfer(makeTokenTransfer({ log_index: null }), WALLET, WALLET_ID, USER_ID);
    const b = normalizeTokenTransfer(
      makeTokenTransfer({ log_index: null, total: { decimals: '6', value: '1' } }),
      WALLET, WALLET_ID, USER_ID,
    );
    expect(a.event.source_key).toMatch(/^transfer:/);
    expect(a.event.source_key).not.toBe(b.event.source_key);
  });
});

describe('isIngestibleNativeTx', () => {
  const keep = isIngestibleNativeTx(12_000_000);

  it('keeps successful value-bearing txs in range', () => {
    expect(keep(makeNativeTx())).toBe(true);
  });

  it('skips failed/reverted txs', () => {
    expect(keep(makeNativeTx({ status: 'error' }))).toBe(false);
  });

  it('skips pending txs with no status', () => {
    expect(keep(makeNativeTx({ status: null as unknown as string }))).toBe(false);
  });

  it('skips zero-value txs', () => {
    expect(keep(makeNativeTx({ value: '0' }))).toBe(false);
  });

  it('skips txs before the start block', () => {
    expect(keep(makeNativeTx({ block: 11_999_999 }))).toBe(false);
  });
});
