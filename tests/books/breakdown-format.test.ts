import { describe, it, expect } from 'vitest';
import { significant, usdDisplay } from '../../src/books/breakdown.js';

describe('significant', () => {
  it('rounds an 18-decimal ETH fee to 6 significant digits, never in exponent form', () => {
    expect(significant(0.000006670978989347)).toBe('0.00000667098');
    expect(significant(0.000004928497331409)).toBe('0.0000049285');
    expect(significant(1e-9)).toBe('0.000000001');
  });

  it('keeps whole and ordinary amounts readable', () => {
    expect(significant(25_000)).toBe('25,000');
    expect(significant(0.438831)).toBe('0.438831');
    expect(significant(49.44)).toBe('49.44');
    expect(significant(1_234_567.891)).toBe('1,234,568');
    expect(significant(-12.5)).toBe('-12.5');
  });
});

describe('usdDisplay', () => {
  it('shows two decimals from $0.10 up, with separators and sign', () => {
    expect(usdDisplay(1200)).toBe('$1,200.00');
    expect(usdDisplay(0.44)).toBe('$0.44');
    expect(usdDisplay(-50)).toBe('-$50.00');
  });

  it('keeps small fees from reading as zero', () => {
    expect(usdDisplay(0.016)).toBe('$0.016');
    expect(usdDisplay(0.0132)).toBe('$0.013');
    expect(usdDisplay(0.05)).toBe('$0.05');
    expect(usdDisplay(0.0049)).toBe('$0.0049');
    expect(usdDisplay(0)).toBe('$0.00');
  });
});
