import { significant, usdDisplay } from './breakdown.js';

// One way to write an amount, everywhere Luca speaks: whole tokens from 1,000 up
// ("477,566 BNKR"), two decimals from 1 ("349.12 USDC"), four significant figures below
// that ("0.001393 ETH"), and dollars whenever there is a price ("$202.74"). Never the raw
// chain amount ("477,566.441686 BNKR", "0.00001393291233761 ETH").

// Holdings worth less than this are dust and left out of lists
export const DUST_USD = 0.01;

export function tokenAmount(n: number, asset: string | null): string {
  const abs = Math.abs(n);
  const body = abs >= 1000
    ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : abs >= 1
      ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : significant(n, 4);
  return asset ? `${body} ${asset}` : body;
}

export const usdText = usdDisplay;

// "477,566 BNKR ($202.74)", or just the tokens when there is no price
export function amountWithUsd(n: number, asset: string | null, usd: number | null): string {
  return usd === null || !Number.isFinite(usd) ? tokenAmount(n, asset) : `${tokenAmount(n, asset)} (${usdText(usd)})`;
}

// A USDC amount is its dollar value: "349.12 USDC", never "349.12 USDC ($349.12)"
export function amountText(n: number, asset: string | null, usd: number | null): string {
  return asset === 'USDC' ? tokenAmount(n, asset) : amountWithUsd(n, asset, usd);
}
