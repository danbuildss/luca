import { describe, it, expect } from 'vitest';
import { classifyByCounterparty } from '../../src/classification/counterparty.js';
import type { UnclassifiedEvent } from '../../src/classification/types.js';
import type { CounterpartyRuleRow } from '../../src/classification/types.js';

const KNOWN = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USER_WALLET = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeEvent(overrides: Partial<UnclassifiedEvent> = {}): UnclassifiedEvent {
  return {
    id: 'evt-1',
    user_id: 'user-1',
    wallet_id: 'wallet-1',
    hash: '0xdeadbeef',
    log_index: null,
    block_time: new Date('2024-01-15T10:00:00Z'),
    from_address: KNOWN,
    to_address: USER_WALLET,
    asset: 'USDC',
    amount: 50,
    direction: 'in',
    ...overrides,
  };
}

const rules: CounterpartyRuleRow[] = [
  { address: KNOWN, label: 'revenue', name: 'Acme Corp', confidence: 0.95 },
  { address: '0xcccccccccccccccccccccccccccccccccccccccc', label: 'expense', name: null, confidence: 0.9 },
];

describe('classifyByCounterparty', () => {
  it('classifies incoming event where from_address matches a rule', () => {
    const event = makeEvent({ direction: 'in', from_address: KNOWN });
    const result = classifyByCounterparty(event, rules);
    expect(result?.label).toBe('revenue');
    expect(result?.confidence).toBe(0.95);
    expect(result?.method).toBe('counterparty');
    expect(result?.evidence).toContain('Acme Corp');
  });

  it('classifies outgoing event where to_address matches a rule', () => {
    const event = makeEvent({
      direction: 'out',
      from_address: USER_WALLET,
      to_address: '0xcccccccccccccccccccccccccccccccccccccccc',
    });
    const result = classifyByCounterparty(event, rules);
    expect(result?.label).toBe('expense');
    expect(result?.confidence).toBe(0.9);
  });

  it('is case-insensitive for address matching', () => {
    const event = makeEvent({ direction: 'in', from_address: KNOWN.toUpperCase() });
    const result = classifyByCounterparty(event, rules);
    expect(result?.label).toBe('revenue');
  });

  it('returns null when no rule matches the counterparty', () => {
    const event = makeEvent({
      direction: 'in',
      from_address: '0x9999999999999999999999999999999999999999',
    });
    const result = classifyByCounterparty(event, rules);
    expect(result).toBeNull();
  });

  it('returns null when rules array is empty', () => {
    const event = makeEvent({ direction: 'in', from_address: KNOWN });
    const result = classifyByCounterparty(event, []);
    expect(result).toBeNull();
  });

  it('returns null when counterparty address is null (outgoing with no to_address)', () => {
    const event = makeEvent({
      direction: 'out',
      from_address: USER_WALLET,
      to_address: null,
    });
    const result = classifyByCounterparty(event, rules);
    expect(result).toBeNull();
  });

  it('uses address prefix in evidence when rule name is null', () => {
    const event = makeEvent({
      direction: 'out',
      from_address: USER_WALLET,
      to_address: '0xcccccccccccccccccccccccccccccccccccccccc',
    });
    const result = classifyByCounterparty(event, rules);
    expect(result?.evidence).toContain('0xcccccccc');
  });

  it('includes source note in evidence', () => {
    const event = makeEvent({ direction: 'in', from_address: KNOWN });
    const result = classifyByCounterparty(event, rules);
    expect(result?.evidence).toContain('user correction');
  });
});
