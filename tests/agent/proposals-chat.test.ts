import { describe, it, expect } from 'vitest';
import { bareAnswer, numberedAnswer, explicitAnswer } from '../../src/agent/proposals-chat.js';

// Which messages answer Luca's question about earlier transfers, decided in code
describe('answers to a question about earlier transfers', () => {
  it('a bare yes or no, and nothing more', () => {
    for (const m of ['yes', 'Yes!', 'yeah', 'ok', 'Sure.', 'go ahead', 'do it', 'yes please', '\u{1F44D}']) expect(bareAnswer(m), m).toBe(true);
    for (const m of ['no', 'No.', 'nope', 'no thanks', "don't", 'leave them', 'leave it as it is', 'cancel', '\u{1F44E}']) expect(bareAnswer(m), m).toBe(false);
    for (const m of ['yes, but only the last two', 'what did gas cost?', 'yes to 1', 'no idea', 'okay what about revenue']) {
      expect(bareAnswer(m), m).toBeNull();
    }
  });

  it('a numbered answer to the list Luca showed', () => {
    expect(numberedAnswer('yes to 1')).toEqual({ n: 1, accept: true });
    expect(numberedAnswer('No to #2.')).toEqual({ n: 2, accept: false });
    expect(numberedAnswer('yes 3')).toEqual({ n: 3, accept: true });
    expect(numberedAnswer('2: no')).toEqual({ n: 2, accept: false });
    expect(numberedAnswer('yes')).toBeNull();
    expect(numberedAnswer('yes to all of them')).toBeNull();
  });

  it("an explicit answer the model reports must match the operator's own words", () => {
    expect(explicitAnswer('yes please update those earlier payments too', true)).toBe(true);
    expect(explicitAnswer('no, leave the old ones as they are', false)).toBe(true);
    expect(explicitAnswer('no, leave the old ones as they are', true)).toBe(false);
    expect(explicitAnswer("yes but don't touch the old ones", true)).toBe(false);
    expect(explicitAnswer('what were those payments for?', true)).toBe(false);
    expect(explicitAnswer('what were those payments for?', false)).toBe(false);
  });
});
