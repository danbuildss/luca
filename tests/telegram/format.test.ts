import { describe, it, expect } from 'vitest';
import {
  formatAddress,
  formatAmount,
  sanitizeName,
  escapeMarkdown,
} from '../../src/telegram/format.js';

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
    expect(formatAmount(1234.5678, 'ETH')).toBe('1,234.57 ETH');
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
