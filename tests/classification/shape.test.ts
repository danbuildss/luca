import { describe, it, expect } from 'vitest';
import { txShape, BASE_WETH, type Leg } from '../../src/classification/shape.js';
import { BASE_USDC, BASE_BNKR } from '../../src/ingestion/assets.js';

const ME = '0x000000000000000000000000000000000000a11c';
const MINE_TOO = '0x000000000000000000000000000000000000b0b0';
const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481';
const POOL = '0x0000000000000000000000000000000000000010';
const SPAM = '0x1111111111111111111111111111111111111111';

let n = 0;
function leg(o: Partial<Leg> & Pick<Leg, 'direction'>): Leg {
  n++;
  const token = o.token_address === undefined ? BASE_USDC : o.token_address;
  const asset = o.asset ?? (token === null ? 'ETH' : token === BASE_USDC ? 'USDC' : token === BASE_BNKR ? 'BNKR' : 'X');
  return {
    id: `leg-${n}`,
    asset,
    token_address: token,
    supported: o.supported ?? (token === null || token === BASE_USDC || token === BASE_BNKR),
    amount: 100,
    source_key: `log:${n}`,
    from_address: o.direction === 'in' ? POOL : ME,
    to_address: o.direction === 'in' ? ME : ROUTER,
    ...o,
  };
}
const gas = (): Leg => leg({ direction: 'out', token_address: null, amount: 0.00001, source_key: 'gas', to_address: null });

describe('txShape', () => {
  it('a plain payment is a single transfer', () => {
    expect(txShape([leg({ direction: 'out' }), gas()], [ME]).shape).toBe('single');
  });

  it('several payments in one direction (a batch) are single transfers', () => {
    expect(txShape([leg({ direction: 'out' }), leg({ direction: 'out', to_address: POOL })], [ME]).shape).toBe('single');
  });

  it('USDC out and BNKR in is a swap', () => {
    const r = txShape([
      leg({ direction: 'out', amount: 100 }),
      leg({ direction: 'in', token_address: BASE_BNKR, amount: 25_000 }),
      gas(),
    ], [ME]);
    expect(r).toEqual({ shape: 'swap', summary: 'Swapped 100 USDC for 25,000 BNKR' });
  });

  it('ETH out and USDC in is a swap, even with leftover ETH refunded', () => {
    const r = txShape([
      leg({ direction: 'out', token_address: null, amount: 0.05, source_key: 'external' }),
      leg({ direction: 'in', token_address: null, amount: 0.01, source_key: 'internal:0' }),
      leg({ direction: 'in', amount: 160 }),
    ], [ME]);
    expect(r.shape).toBe('swap');
    expect(r.summary).toBe('Swapped 0.04 ETH for 160 USDC');
  });

  it('wrapping ETH into WETH is a swap (a conversion)', () => {
    const r = txShape([
      leg({ direction: 'out', token_address: null, amount: 0.1, to_address: BASE_WETH, source_key: 'external' }),
      leg({ direction: 'in', token_address: BASE_WETH, supported: false, amount: 0.1 }),
    ], [ME]);
    expect(r).toEqual({ shape: 'swap', summary: 'Wrapped or unwrapped ETH' });
  });

  it('only moves between my own wallets is internal', () => {
    expect(txShape([leg({ direction: 'out', to_address: MINE_TOO })], [ME, MINE_TOO]).shape).toBe('internal');
  });

  it('nothing but the fee is gas', () => {
    expect(txShape([gas()], [ME]).shape).toBe('gas');
  });

  it('an untracked token going out while ETH comes in is complex, never guessed', () => {
    const r = txShape([
      leg({ direction: 'out', token_address: SPAM, supported: false, amount: 1_000 }),
      leg({ direction: 'in', token_address: null, amount: 0.2, source_key: 'internal:0' }),
    ], [ME]);
    expect(r.shape).toBe('complex');
  });

  it('USDC in from one party and part of it out to another is complex', () => {
    const r = txShape([
      leg({ direction: 'in', amount: 100 }),
      leg({ direction: 'out', amount: 5, to_address: SPAM }),
    ], [ME]);
    expect(r.shape).toBe('complex');
  });

  it('zero-value movements are ignored', () => {
    expect(txShape([leg({ direction: 'out' }), leg({ direction: 'in', token_address: BASE_BNKR, amount: 0 })], [ME]).shape)
      .toBe('single');
  });
});
