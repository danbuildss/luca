import type { UnclassifiedEvent, ClassificationResult, CounterpartyRuleRow } from './types.js';

// Pick the rule for this counterparty that applies to the event's direction.
// A direction-specific rule wins over a legacy (direction-less) rule; a rule for the
// opposite direction never applies (a customer's payment label must not leak onto a
// refund we send back to them).
export function findCounterpartyRule(
  counterparty: string,
  direction: 'in' | 'out',
  rules: CounterpartyRuleRow[],
): CounterpartyRuleRow | null {
  const addr = counterparty.toLowerCase();
  let anyDirection: CounterpartyRuleRow | null = null;
  for (const rule of rules) {
    if (rule.address.toLowerCase() !== addr) continue;
    if (rule.direction === direction) return rule;
    if ((rule.direction === null || rule.direction === undefined) && !anyDirection) {
      anyDirection = rule;
    }
  }
  return anyDirection;
}

export function classifyByCounterparty(
  event: UnclassifiedEvent,
  rules: CounterpartyRuleRow[],
): ClassificationResult | null {
  if (rules.length === 0) return null;

  // The counterparty is the address that is NOT the user's wallet.
  // For incoming: the sender (from_address) is the counterparty.
  // For outgoing: the recipient (to_address) is the counterparty.
  const counterparty =
    event.direction === 'in' ? event.from_address : event.to_address;

  if (!counterparty) return null;

  const rule = findCounterpartyRule(counterparty, event.direction, rules);
  if (!rule) return null;

  const name = rule.name ?? counterparty.slice(0, 10) + '…';
  return {
    label: rule.label,
    confidence: rule.confidence,
    method: 'counterparty',
    evidence: `Counterparty "${name}" matches saved rule (source: user correction)`,
  };
}
