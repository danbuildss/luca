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
    expect(result?.evidence).toContain('learned from your answer');
  });
});

describe('classifyByCounterparty — direction-aware rules', () => {
  const CUSTOMER = '0x1111111111111111111111111111111111111111';

  it('does not apply an incoming-only rule to an outgoing refund', () => {
    const directional: CounterpartyRuleRow[] = [
      { address: CUSTOMER, label: 'revenue', name: 'Customer', confidence: 1, direction: 'in' },
    ];
    const refund = makeEvent({ direction: 'out', from_address: USER_WALLET, to_address: CUSTOMER });
    expect(classifyByCounterparty(refund, directional)).toBeNull();

    const payment = makeEvent({ direction: 'in', from_address: CUSTOMER, to_address: USER_WALLET });
    expect(classifyByCounterparty(payment, directional)?.label).toBe('revenue');
  });

  it('applies legacy (null-direction) rules in both directions', () => {
    const legacy: CounterpartyRuleRow[] = [
      { address: CUSTOMER, label: 'revenue', name: null, confidence: 1, direction: null },
    ];
    const inEvt = makeEvent({ direction: 'in', from_address: CUSTOMER });
    const outEvt = makeEvent({ direction: 'out', from_address: USER_WALLET, to_address: CUSTOMER });
    expect(classifyByCounterparty(inEvt, legacy)?.label).toBe('revenue');
    expect(classifyByCounterparty(outEvt, legacy)?.label).toBe('revenue');
  });

  it('prefers a direction-specific rule over a legacy rule', () => {
    const mixed: CounterpartyRuleRow[] = [
      { address: CUSTOMER, label: 'revenue', name: null, confidence: 1, direction: null },
      { address: CUSTOMER, label: 'refund', name: null, confidence: 1, direction: 'out' },
    ];
    const outEvt = makeEvent({ direction: 'out', from_address: USER_WALLET, to_address: CUSTOMER });
    const inEvt = makeEvent({ direction: 'in', from_address: CUSTOMER });
    expect(classifyByCounterparty(outEvt, mixed)?.label).toBe('refund');
    expect(classifyByCounterparty(inEvt, mixed)?.label).toBe('revenue');
  });

  it('picks the matching rule when both directions have rules', () => {
    const both: CounterpartyRuleRow[] = [
      { address: CUSTOMER, label: 'refund', name: null, confidence: 1, direction: 'out' },
      { address: CUSTOMER.toUpperCase(), label: 'revenue', name: null, confidence: 1, direction: 'in' },
    ];
    const inEvt = makeEvent({ direction: 'in', from_address: CUSTOMER });
    expect(classifyByCounterparty(inEvt, both)?.label).toBe('revenue');
  });
});
