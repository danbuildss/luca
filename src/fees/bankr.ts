import axios from 'axios';
import { z } from 'zod';

// Bankr's public fee data for one token (no key; Luca never holds a Bankr API key).
// Everything here is "reported by Bankr": Luca checks it against the chain where it can
// (claims, src/fees/claims.ts) and never presents it as an on-chain fact.
export const BANKR_PUBLIC_API = 'https://api.bankr.bot/public/doppler';
const TIMEOUT_MS = 10_000;

const Amount = z.string().regex(/^\d+(\.\d+)?$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());

const TokenFees = z.object({
  address: Address,
  chain: z.string(),
  tokens: z.array(z.object({
    tokenAddress: Address,
    symbol: z.string(),
    poolId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((p) => p.toLowerCase()),
    feesContract: Address,
    numeraire: Address,
    tokenIsToken0: z.boolean(),
    token0Label: z.string(),
    token1Label: z.string(),
    claimable: z.object({ token0: Amount, token1: Amount }),
    claimed: z.object({ token0: Amount, token1: Amount, count: z.number().int().nonnegative() }),
  }).passthrough()),
}).passthrough();

export type BankrTokenFees = {
  recipient: string;        // the wallet Bankr pays these fees to
  chain: string;
  token: string;
  symbol: string;
  poolId: string;
  feesContract: string;
  feeToken: string;         // the numeraire: fees are paid in this token
  feeLabel: string;         // Bankr's name for it, e.g. "BNKR"
  claimable: string;        // fee token units, as reported
  claimed: string;
  claimCount: number;
  raw: unknown;
};

export class BankrUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankrUnavailable';
  }
}

// The fee side of the pool is the numeraire (the other side is the token itself)
export function parseTokenFees(body: unknown, token: string): BankrTokenFees {
  const parsed = TokenFees.safeParse(body);
  if (!parsed.success) throw new BankrUnavailable('Bankr returned data in a shape Luca does not recognise');
  const t = parsed.data.tokens.find((x) => x.tokenAddress === token.toLowerCase());
  if (!t) throw new BankrUnavailable(`Bankr returned no fee data for ${token.toLowerCase()}`);
  const side = t.tokenIsToken0 ? 'token1' : 'token0';
  return {
    recipient: parsed.data.address,
    chain: parsed.data.chain,
    token: t.tokenAddress,
    symbol: t.symbol,
    poolId: t.poolId,
    feesContract: t.feesContract,
    feeToken: t.numeraire,
    feeLabel: side === 'token0' ? t.token0Label : t.token1Label,
    claimable: t.claimable[side],
    claimed: t.claimed[side],
    claimCount: t.claimed.count,
    raw: body,
  };
}

export async function fetchTokenFees(token: string): Promise<BankrTokenFees> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new BankrUnavailable('Not a token address');
  let body: unknown;
  try {
    const res = await axios.get<unknown>(`${BANKR_PUBLIC_API}/token-fees/${token.toLowerCase()}`, {
      params: { days: 1 },
      timeout: TIMEOUT_MS,
    });
    body = res.data;
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const timedOut = axios.isAxiosError(err) && err.code === 'ECONNABORTED';
    throw new BankrUnavailable(
      timedOut ? 'Bankr did not answer within 10 seconds'
        : status ? `Bankr answered with HTTP ${status}`
          : 'Bankr could not be reached',
    );
  }
  return parseTokenFees(body, token);
}
