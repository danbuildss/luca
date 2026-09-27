import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({
  default: { get, isAxiosError: (e: unknown) => typeof e === 'object' && e !== null && 'isAxiosError' in e },
}));

import { parseTokenFees, fetchTokenFees, BankrUnavailable } from '../../src/fees/bankr.js';

import { ACCUM, ACCUM_RESPONSE } from './fixtures.js';

describe("Bankr's public fee data", () => {
  it('reads the fee side of the pool (BNKR, the numeraire), never the token side', () => {
    const f = parseTokenFees(ACCUM_RESPONSE, ACCUM.toUpperCase().replace('0X', '0x'));
    expect(f).toMatchObject({
      recipient: '0xb54081ff3f6a90a5a1057d8a5537f7f14e376fdb',
      chain: 'base',
      token: ACCUM,
      symbol: 'ACCUM',
      poolId: '0xf50f308dde18f40b30b9f818f3afead3c67cafd82e695f0ad0d2c8444dea37eb',
      feesContract: '0x9982538f41f2ae29ddb9d3d9307010052984fdbb',
      feeToken: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b',
      feeLabel: 'BNKR',
      claimable: '2713229.471936',
      claimed: '0.000000',
      claimCount: 0,
    });
    // The token on the other side of the pool: the fee side is token1
    const flipped = { ...ACCUM_RESPONSE, tokens: [{ ...ACCUM_RESPONSE.tokens[0], tokenIsToken0: true, token0Label: 'ACCUM', token1Label: 'BNKR', claimable: { token0: '5', token1: '7' } }] };
    expect(parseTokenFees(flipped, ACCUM)).toMatchObject({ feeLabel: 'BNKR', claimable: '7' });
  });

  it('fails clearly on a response it does not recognise or that lacks the token', () => {
    expect(() => parseTokenFees({ hello: 1 }, ACCUM)).toThrow(BankrUnavailable);
    expect(() => parseTokenFees({ ...ACCUM_RESPONSE, tokens: [] }, ACCUM)).toThrow(/no fee data for 0x70ae/);
    const bad = { ...ACCUM_RESPONSE, tokens: [{ ...ACCUM_RESPONSE.tokens[0], claimable: { token0: '-1', token1: '0' } }] };
    expect(() => parseTokenFees(bad, ACCUM)).toThrow(/shape Luca does not recognise/);
  });

  describe('fetching', () => {
    beforeEach(() => get.mockReset());

    it('asks the public endpoint with a 10 second timeout and no key', async () => {
      get.mockResolvedValue({ data: ACCUM_RESPONSE });
      await fetchTokenFees(ACCUM);
      expect(get).toHaveBeenCalledWith(
        `https://api.bankr.bot/public/doppler/token-fees/${ACCUM}`,
        { params: { days: 1 }, timeout: 10_000 },
      );
    });

    it('says why Bankr could not be read', async () => {
      get.mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNABORTED' });
      await expect(fetchTokenFees(ACCUM)).rejects.toThrow('Bankr did not answer within 10 seconds');
      get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } });
      await expect(fetchTokenFees(ACCUM)).rejects.toThrow('Bankr answered with HTTP 503');
      get.mockRejectedValueOnce(new Error('ENOTFOUND'));
      await expect(fetchTokenFees(ACCUM)).rejects.toThrow('Bankr could not be reached');
    });
  });
});
