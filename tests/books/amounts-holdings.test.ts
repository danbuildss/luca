import { describe, it, expect } from 'vitest';
import { tokenAmount, amountText } from '../../src/books/amounts.js';
import { isAddressLike, ownWalletName } from '../../src/books/names.js';
import { holdingsChange, holdingsLine, type Holdings } from '../../src/briefs/generate.js';

describe('amounts, one way everywhere', () => {
  it('Oct 4: no raw chain amounts', () => {
    expect(tokenAmount(477566.441686, 'BNKR')).toBe('477,566 BNKR');
    expect(tokenAmount(0.00001393291233761, 'ETH')).toBe('0.00001393 ETH');
    expect(tokenAmount(349.12, 'USDC')).toBe('349.12 USDC');
    expect(tokenAmount(0.0014997, 'ETH')).toBe('0.0015 ETH');
    expect(amountText(70730.596728, 'BNKR', 30.03)).toBe('70,731 BNKR ($30.03)');
    expect(amountText(106.88, 'USDC', 106.88)).toBe('106.88 USDC');
    expect(amountText(5, 'BNKR', null)).toBe('5 BNKR');
  });
});

describe('names', () => {
  it('an address is not a name', () => {
    for (const n of ['0x8847…584a', '0x88470240ff0663faefa68b1d7621b472ddd9584a', '0x8847...584a', '', null]) expect(isAddressLike(n), String(n)).toBe(true);
    for (const n of ['OpenAI', 'ops wallet', '0xSplits treasury']) expect(isAddressLike(n), n).toBe(false);
  });

  it('own wallets read naturally', () => {
    expect(ownWalletName('main', '0x' + 'a'.repeat(40))).toBe('your main wallet');
    expect(ownWalletName('Luca wallet', '0x' + 'a'.repeat(40))).toBe('your Luca wallet');
    expect(ownWalletName(null, '0x4456' + 'a'.repeat(32) + 'b1c2')).toBe('your wallet 0x4456…b1c2');
  });
});

describe('holdings, and why they changed', () => {
  const h = (assets: Holdings['assets'], hoursAgo = 0): Holdings => ({ at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), assets });

  it('splits a change exactly into the price and money that moved', () => {
    const prev = h({ BNKR: { wallet: 1000, staked: 1000, price: 0.5 }, USDC: { wallet: 500, staked: 0, price: 1 } }, 24);
    const now = h({ BNKR: { wallet: 1000, staked: 1000, price: 0.4 }, USDC: { wallet: 300, staked: 0, price: 1 } });
    const c = holdingsChange(prev, now)!;
    expect(c.delta).toBeCloseTo(-400);
    expect(c.price).toEqual([{ asset: 'BNKR', usd: expect.closeTo(-200) as number, pct: expect.closeTo(-0.2) as number }]);
    expect(c.moved).toBeCloseTo(-200);
    expect(c.price[0].usd + c.moved).toBeCloseTo(c.delta);
  });

  it('a stake moves nothing out of holdings', () => {
    const prev = h({ BNKR: { wallet: 2_100_000, staked: 700_000, price: 0.0004245 } }, 24);
    const now = h({ BNKR: { wallet: 1_400_000, staked: 1_400_000, price: 0.0004245 } });
    expect(holdingsChange(prev, now)).toMatchObject({ delta: 0, moved: 0 });
    expect(holdingsLine(now, prev, 'yesterday')).toBe('Holdings: $1,188.60 ($594.30 in your wallets, $594.30 staked).');
  });

  it('says why: the price, or money that went out; small changes are left out', () => {
    const prev = h({ USDC: { wallet: 1000, staked: 0, price: 1 } }, 24);
    expect(holdingsLine(h({ USDC: { wallet: 500, staked: 0, price: 1 } }), prev, 'yesterday'))
      .toBe('Holdings: $500.00, down $500.00 since yesterday, mostly $500.00 that went out.');
    expect(holdingsLine(h({ USDC: { wallet: 1003, staked: 0, price: 1 } }), prev, 'yesterday')).toBe('Holdings: $1,003.00.');
    const eth = h({ ETH: { wallet: 1, staked: 0, price: 4000 } }, 24);
    expect(holdingsLine(h({ ETH: { wallet: 1, staked: 0, price: 4400 } }), eth, 'Oct 2'))
      .toBe('Holdings: $4,400.00, up $400.00 since Oct 2, mostly ETH\'s price (up 10%).');
  });

  it('no comparison without a price on both days', () => {
    expect(holdingsChange(h({ BNKR: { wallet: 1, staked: 0, price: null } }), h({ BNKR: { wallet: 1, staked: 0, price: 1 } }))).toBeNull();
  });
});
