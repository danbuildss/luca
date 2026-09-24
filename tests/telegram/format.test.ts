import { describe, it, expect } from 'vitest';
import {
  formatAddress,
  formatAmount,
  figuresBlock,
  sanitizeName,
  escapeMarkdown,
  escapeLegacyMarkdown,
  chunkMessage,
  sendMarkdownSafe,
} from '../../src/telegram/format.js';

describe('escapeLegacyMarkdown', () => {
  it('escapes only _ * ` [', () => {
    expect(escapeLegacyMarkdown('internal_transfer *x* `y` [z](u).')).toBe(
      'internal\\_transfer \\*x\\* \\`y\\` \\[z](u).',
    );
  });
});

describe('chunkMessage', () => {
  it('splits long text on newlines within the limit', () => {
    const text = ['a'.repeat(6), 'b'.repeat(6), 'c'.repeat(6)].join('\n');
    const chunks = chunkMessage(text, 10);
    expect(chunks).toEqual(['aaaaaa', 'bbbbbb', 'cccccc']);
  });
});

describe('sendMarkdownSafe', () => {
  it('falls back to plain text when Telegram rejects the Markdown, keeping extra', async () => {
    const calls: Array<{ text: string; extra: Record<string, unknown> }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- throwing inside async yields a rejected promise, like Telegram
    const send = async (text: string, extra: Record<string, unknown>) => {
      calls.push({ text, extra });
      if (extra.parse_mode === 'Markdown') {
        throw Object.assign(new Error('400'), { description: "Bad Request: can't parse entities" });
      }
      return { message_id: 1 };
    };
    const res = await sendMarkdownSafe(send, 'bad _markdown', { reply_markup: { k: 1 } });
    expect(res).toEqual({ message_id: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1].extra).toEqual({ reply_markup: { k: 1 } });
  });

  it('sends a placeholder instead of an empty message', async () => {
    const texts: string[] = [];
    await sendMarkdownSafe((t) => { texts.push(t); return Promise.resolve(null); }, '   ');
    expect(texts).toEqual(['…']);
  });
});

describe('formatAddress', () => {
  it('truncates a full address to 0xABCD…wxyz form', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(formatAddress(addr)).toBe('0x1234…5678');
  });

  it('returns short strings unchanged', () => {
    expect(formatAddress('0x123')).toBe('0x123');
  });
});

describe('formatAmount', () => {
  it('formats a number with 2 decimal places and asset', () => {
    expect(formatAmount('150.5', 'USDC')).toBe('150.50 USDC');
  });

  it('returns — for null amount', () => {
    expect(formatAmount(null)).toBe('—');
  });

  it('handles numeric input', () => {
    expect(formatAmount(1234.5678, 'ETH')).toBe('1,234.5678 ETH');
  });

  it('keeps small token amounts visible but rounds USDC to cents', () => {
    expect(formatAmount(0.000758, 'ETH')).toBe('0.000758 ETH');
    expect(formatAmount(13.711609, 'USDC')).toBe('13.71 USDC');
  });
});

describe('sanitizeName', () => {
  it('strips markdown special characters', () => {
    expect(sanitizeName('*evil* `injection`', 'fallback')).toBe('evil injection');
  });

  it('truncates to 40 characters', () => {
    const long = 'A'.repeat(60);
    expect(sanitizeName(long, 'fallback').length).toBe(40);
  });

  it('returns fallback when name is null', () => {
    expect(sanitizeName(null, '0xfallback')).toBe('0xfallback');
  });
});

describe('escapeMarkdown', () => {
  it('escapes dots, dashes, and underscores', () => {
    const result = escapeMarkdown('hello_world. test-case!');
    expect(result).toContain('\\_');
    expect(result).toContain('\\.');
    expect(result).toContain('\\!');
  });
});

describe('figuresBlock', () => {
  it('wraps rows in a code block with labels left-aligned and amounts right-aligned', () => {
    const block = figuresBlock([
      ['Cash', '$8,420.00'],
      ['Gas', '-$83.00'],
    ]);
    expect(block).toBe(['```', 'Cash   $8,420.00', 'Gas      -$83.00', '```'].join('\n'));
  });

  it('aligns every column and drops trailing padding', () => {
    const block = figuresBlock([
      ['ETH', '0.0008', '$3.10'],
      ['USDC', '0.44', '$0.44'],
    ]).split('\n');
    expect(block[1]).toBe('ETH    0.0008   $3.10');
    expect(block[2]).toBe('USDC     0.44   $0.44');
  });
});

