import { describe, it, expect } from 'vitest';
import { parseNumberedAnswer } from '../../src/agent/numbered.js';

const read = (t: string) => {
  const r = parseNumberedAnswer(t);
  return r ? { labels: Object.fromEntries(r.labels), unsure: r.unsure } : null;
};

describe('an answer by number to Luca\'s list', () => {
  it('Oct 5, Dan\'s exact answer', () => {
    expect(read('1 was an expense, 2 was an internal transfer, 3 was a swap, 4 and 7 were swaps, 5 and 6 were swaps, not sure about 8')).toEqual({
      labels: { 1: 'expense', 2: 'internal_transfer', 3: 'swap', 4: 'swap', 5: 'swap', 6: 'swap', 7: 'swap' },
      unsure: [8],
    });
  });

  it('other ways of saying it', () => {
    expect(read('1 was a swap, 2 was revenue')).toEqual({ labels: { 1: 'swap', 2: 'revenue' }, unsure: [] });
    expect(read('1, 2 and 3 were expenses')).toEqual({ labels: { 1: 'expense', 2: 'expense', 3: 'expense' }, unsure: [] });
    expect(read('1 was a swap and 2 was revenue.')).toEqual({ labels: { 1: 'swap', 2: 'revenue' }, unsure: [] });
    expect(read('3 is a refund, skip 4')).toEqual({ labels: { 3: 'refund' }, unsure: [4] });
  });

  it('anything else is left to the conversation', () => {
    for (const t of ['what was 1?', '1 was for my mom', '1 was a swap, also the 35 USDC was revenue', 'not sure about 8', 'yes', 'the 49.79 was revenue']) {
      expect(read(t), t).toBeNull();
    }
  });
});
