// On-chain evidence for anything Luca says about a transaction: a BaseScan link the
// operator can tap to check the claim against the chain.
//
//   txLink('0xf5a2…')  →  "[0xf5a2…a0e3](https://basescan.org/tx/0xf5a2…)"
//
// The link text is Telegram legacy Markdown. Hashes are hex, so nothing in it needs
// escaping; anything that is not a full hash gets no link (never a link built from
// text we did not check).

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export const EXPLORER_TX_URL = 'https://basescan.org/tx/';

export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

export function txUrl(hash: string): string | null {
  return TX_HASH.test(hash) ? `${EXPLORER_TX_URL}${hash.toLowerCase()}` : null;
}

export function txLink(hash: string): string {
  const url = txUrl(hash);
  return url ? `[${shortHash(hash)}](${url})` : shortHash(hash);
}

// The same link on every row that names a transaction
export function withLink<T extends { hash: string }>(row: T): T & { link: string } {
  return { ...row, link: txLink(row.hash) };
}
