// Luca tracks exactly three assets on Base. Identity is native-ness or contract address,
// never the ticker symbol: anyone can deploy a token named "USDC" or "ETH".
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_BNKR = '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b';

export type SupportedSymbol = 'ETH' | 'USDC' | 'BNKR';

type TokenInfo = { symbol: SupportedSymbol; decimals: number };

export const SUPPORTED_TOKENS: Readonly<Record<string, TokenInfo>> = {
  [BASE_USDC]: { symbol: 'USDC', decimals: 6 },
  [BASE_BNKR]: { symbol: 'BNKR', decimals: 18 },
};

export type AssetIdentity = {
  supported: boolean;
  symbol: string | null;
  tokenAddress: string | null; // lowercase contract; null for native ETH
};

export function identifyAsset(params: {
  native: boolean;
  tokenAddress: string | null | undefined;
  providerSymbol: string | null | undefined;
}): AssetIdentity {
  if (params.native) return { supported: true, symbol: 'ETH', tokenAddress: null };
  const tokenAddress = params.tokenAddress ? params.tokenAddress.toLowerCase() : null;
  const known = tokenAddress ? SUPPORTED_TOKENS[tokenAddress] : undefined;
  if (known) return { supported: true, symbol: known.symbol, tokenAddress };
  // Provider symbols are attacker-controlled; keep a bounded copy for diagnostics only.
  return { supported: false, symbol: params.providerSymbol?.slice(0, 32) ?? null, tokenAddress };
}

// USD value of a normalized_events row: stored value, else USDC at face value (by contract).
export function usdValueSql(alias: string): string {
  return `COALESCE(${alias}.usd_value, CASE WHEN ${alias}.token_address = '${BASE_USDC}' THEN ${alias}.amount END)`;
}
