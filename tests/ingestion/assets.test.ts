import { describe, it, expect } from 'vitest';
import { identifyAsset, BASE_USDC, BASE_BNKR } from '../../src/ingestion/assets.js';
import { normalizeTransfer } from '../../src/ingestion/normalize.js';
import { normalizeTokenTransfer, normalizeNativeTx } from '../../src/ingestion/blockscout.js';
import { scanWindow, TIP_LAG_BLOCKS, OVERLAP_BLOCKS } from '../../src/ingestion/ingest.js';
import { BLOCKS_30_DAYS, type AlchemyTransfer } from '../../src/ingestion/alchemy.js';

const WALLET = '0xabc0000000000000000000000000000000000001';
const OTHER = '0xdef0000000000000000000000000000000000002';
const FAKE = '0x1111111111111111111111111111111111111111';

function alchemy(overrides: Partial<AlchemyTransfer>): AlchemyTransfer {
  return {
    blockNum: '0x7a1200',
    uniqueId: '0xdeadbeef:log:3',
    hash: '0xdeadbeef',
    from: OTHER,
    to: WALLET,
    value: 500,
    asset: 'USDC',
    category: 'erc20',
    metadata: { blockTimestamp: '2026-09-23T10:30:00Z' },
    rawContract: { value: '0x1', address: BASE_USDC, decimal: '0x6' },
    ...overrides,
  };
}

describe('identifyAsset', () => {
  it('treats native transfers as ETH regardless of reported symbol', () => {
    expect(identifyAsset({ native: true, tokenAddress: null, providerSymbol: 'WHATEVER' }))
      .toEqual({ supported: true, symbol: 'ETH', tokenAddress: null });
  });

  it('recognises USDC and BNKR by contract, case-insensitively', () => {
    expect(identifyAsset({ native: false, tokenAddress: BASE_USDC.toUpperCase().replace('0X', '0x'), providerSymbol: 'USD Coin' }))
      .toEqual({ supported: true, symbol: 'USDC', tokenAddress: BASE_USDC });
    expect(identifyAsset({ native: false, tokenAddress: BASE_BNKR, providerSymbol: null }))
      .toEqual({ supported: true, symbol: 'BNKR', tokenAddress: BASE_BNKR });
  });

  it('rejects a token named USDC or ETH at any other contract', () => {
    expect(identifyAsset({ native: false, tokenAddress: FAKE, providerSymbol: 'USDC' }))
      .toEqual({ supported: false, symbol: 'USDC', tokenAddress: FAKE });
    expect(identifyAsset({ native: false, tokenAddress: FAKE, providerSymbol: 'ETH' }).supported).toBe(false);
  });

  it('caps attacker-controlled symbols', () => {
    const r = identifyAsset({ native: false, tokenAddress: FAKE, providerSymbol: 'x'.repeat(200) });
    expect(r.symbol).toHaveLength(32);
  });
});

describe('normalizers carry asset identity', () => {
  it('Alchemy: real USDC is supported with its contract', () => {
    const { event } = normalizeTransfer(alchemy({}), WALLET, 'w', 'u');
    expect(event).toMatchObject({ asset: 'USDC', token_address: BASE_USDC, supported: true });
  });

  it('Alchemy: fake USDC is stored as unsupported', () => {
    const { event } = normalizeTransfer(
      alchemy({ rawContract: { value: '0x1', address: FAKE, decimal: '0x6' } }), WALLET, 'w', 'u',
    );
    expect(event).toMatchObject({ asset: 'USDC', token_address: FAKE, supported: false });
  });

  it('Alchemy: an ERC-20 calling itself ETH is not ETH', () => {
    const { event } = normalizeTransfer(
      alchemy({ asset: 'ETH', rawContract: { value: '0x1', address: FAKE, decimal: '0x12' } }), WALLET, 'w', 'u',
    );
    expect(event.supported).toBe(false);
  });

  it('Alchemy: external and internal transfers are native ETH', () => {
    for (const category of ['external', 'internal'] as const) {
      const { event } = normalizeTransfer(
        alchemy({ category, asset: 'ETH', uniqueId: `0xdeadbeef:${category}`, rawContract: { value: '0x1', address: null, decimal: null } }),
        WALLET, 'w', 'u',
      );
      expect(event).toMatchObject({ asset: 'ETH', token_address: null, supported: true });
    }
  });

  it('Blockscout: token contract decides support; native txs are ETH', () => {
    const base = {
      block_number: 1, from: { hash: OTHER }, to: { hash: WALLET },
      total: { decimals: '18', value: '1000000000000000000' }, tx_hash: '0xabc',
      timestamp: '2026-09-23T10:30:00.000000Z', log_index: '4',
    };
    const bnkr = normalizeTokenTransfer({ ...base, token: { address: BASE_BNKR, decimals: '18', symbol: 'BNKR' } }, WALLET, 'w', 'u');
    expect(bnkr.event).toMatchObject({ asset: 'BNKR', token_address: BASE_BNKR, supported: true });
    const fake = normalizeTokenTransfer({ ...base, token: { address: FAKE, decimals: '18', symbol: 'BNKR' } }, WALLET, 'w', 'u');
    expect(fake.event.supported).toBe(false);
    const eth = normalizeNativeTx({
      hash: '0xabc', block: 1, timestamp: base.timestamp, from: { hash: OTHER }, to: { hash: WALLET },
      value: '1000', gas_used: null, gas_price: null, status: 'ok',
    }, WALLET, 'w', 'u');
    expect(eth.event).toMatchObject({ asset: 'ETH', token_address: null, supported: true });
  });
});

describe('scanWindow', () => {
  const tip = 40_000_000;

  it('backfills 30 days on first sync and stops short of the tip', () => {
    expect(scanWindow(null, tip)).toEqual({
      fromBlock: tip - TIP_LAG_BLOCKS - BLOCKS_30_DAYS, toBlock: tip - TIP_LAG_BLOCKS, isBackfill: true,
    });
  });

  it('re-reads an overlap window behind the cursor', () => {
    const last = tip - 100;
    expect(scanWindow(String(last), tip)).toEqual({
      fromBlock: last + 1 - OVERLAP_BLOCKS, toBlock: tip - TIP_LAG_BLOCKS, isBackfill: false,
    });
  });

  it('skips when the cursor is already at the lagged tip', () => {
    expect(scanWindow(String(tip - TIP_LAG_BLOCKS), tip)).toBeNull();
  });
});
