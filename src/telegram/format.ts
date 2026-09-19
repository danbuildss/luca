// Format a USDC/token amount with commas and 2dp
export function formatAmount(amount: number | string | null, asset = 'USDC'): string {
  if (amount == null) return '—';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(n)) return '—';
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${asset}`;
}

// Truncate an address to "0x1234…abcd" — never embed full addresses in messages
export function formatAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Sanitize a counterparty name to prevent prompt injection via Telegram messages
export function sanitizeName(name: string | null, fallback: string): string {
  if (!name) return fallback;
  // Strip markdown special chars and limit length
  return name.replace(/[*_`[\]()]/g, '').slice(0, 40);
}

export function formatPeriod(days: number): string {
  return days === 7 ? 'Last 7 days' : days === 30 ? 'Last 30 days' : `Last ${days} days`;
}

// Escape characters that have special meaning in Telegram MarkdownV2
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export function signedUsd(amount: number, direction: 'in' | 'out' | null): string {
  if (direction === 'in') return `+$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (direction === 'out') return `-$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
