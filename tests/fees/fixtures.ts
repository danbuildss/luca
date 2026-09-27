// Bankr's public fee data for $ACCUM, as read on Sep 27 2026
export const ACCUM = '0x70aeb20cd233e044bb7676c34105712132f49ba3';
// Trimmed to the fields Luca reads
export const ACCUM_RESPONSE = {
  address: '0xb54081ff3f6a90a5a1057d8a5537f7f14e376fdb',
  chain: 'base',
  days: 1,
  tokens: [{
    tokenAddress: ACCUM,
    name: 'The Accumulator',
    symbol: 'ACCUM',
    poolId: '0xf50f308dde18f40b30b9f818f3afead3c67cafd82e695f0ad0d2c8444dea37eb',
    feesContract: '0x9982538f41f2ae29ddb9d3d9307010052984fdbb',
    share: '95.00%',
    token0Label: 'BNKR',
    token1Label: 'ACCUM',
    numeraire: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b',
    tokenIsToken0: false,
    claimable: { token0: '2713229.471936', token1: '0.000000' },
    claimed: { token0: '0.000000', token1: '0.000000', count: 0 },
  }],
  lifetimeEarnedWeth: '0',
  totals: { claimableWeth: '0.475380', claimedWeth: '0', claimCount: 0 },
};
