import type { Context } from 'telegraf';

// Format a USDC/token amount with commas and 2dp
export function formatAmount(amount: number | string | null, asset = 'USDC'): string {
  if (amount == null) return '—';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(n)) return '—';
  const formatted = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: asset === 'USDC' ? 2 : 6,
  });
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

// Escape user/chain-controlled text for legacy `parse_mode: 'Markdown'`
// (the mode this bot uses). Only _ * ` [ are special there.
export function escapeLegacyMarkdown(text: string): string {
  return text.replace(/[_*`[]/g, '\\$&');
}

// Monospace figures block: first column left-aligned, the rest right-aligned.
// Cells must not contain user-controlled text: Markdown escaping does not apply inside it.
export function figuresBlock(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  }
  const lines = rows.map((row) =>
    row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('   ').trimEnd(),
  );
  return ['```', ...lines, '```'].join('\n');
}

export const TELEGRAM_MAX_LENGTH = 4096;

// Split text into Telegram-sized chunks, preferring newline boundaries.
export function chunkMessage(text: string, max = TELEGRAM_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function isParseError(err: unknown): boolean {
  const desc = (err as { description?: string; message?: string } | null);
  return /can't parse entities/i.test(desc?.description ?? desc?.message ?? '');
}

// Send Markdown text safely: chunks to fit Telegram's limit, and if Telegram
// rejects the Markdown, resends that chunk as plain text instead of failing.
// `extra` (e.g. a reply keyboard) is attached to the last chunk only.
// Returns the last sent message.
export async function sendMarkdownSafe<T>(
  send: (text: string, extra: Record<string, unknown>) => Promise<T>,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<T | null> {
  const body = text.trim() === '' ? '…' : text;
  const chunks = chunkMessage(body);
  let last: T | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const chunkExtra = i === chunks.length - 1 ? extra : {};
    try {
      last = await send(chunks[i], { ...chunkExtra, parse_mode: 'Markdown' });
    } catch (err) {
      if (!isParseError(err)) throw err;
      last = await send(chunks[i], chunkExtra);
    }
  }
  return last;
}

// Convenience wrapper: sendMarkdownSafe via ctx.reply. Pass keyboards as
// `{ reply_markup: kb.reply_markup }` so they land on the last chunk.
export function replyMarkdownSafe(
  ctx: Context,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return sendMarkdownSafe(
    (t, x) => ctx.reply(t, x as Parameters<Context['reply']>[1]),
    text,
    extra,
  );
}

export function signedUsd(amount: number, direction: 'in' | 'out' | null): string {
  if (direction === 'in') return `+$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (direction === 'out') return `-$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
