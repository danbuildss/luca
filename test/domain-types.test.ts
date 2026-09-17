import { describe, expect, it } from 'vitest';

import { classificationLabels } from '../core/domain/types.js';

describe('classification vocabulary', () => {
  it('has one stable, duplicate-free set of stored labels', () => {
    expect(classificationLabels).toEqual([
      'revenue',
      'expense',
      'internal_transfer',
      'treasury',
      'gas',
      'x402_income',
      'x402_spend',
      'refund',
      'unknown',
    ]);
    expect(new Set(classificationLabels).size).toBe(classificationLabels.length);
  });
});
