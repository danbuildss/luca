import type { UnclassifiedEvent, ClassificationResult, CounterpartyRuleRow } from './types.js';

export function classifyByCounterparty(
  event: UnclassifiedEvent,
  rules: CounterpartyRuleRow[],
): ClassificationResult | null {
  if (rules.length === 0) return null;

  const ruleMap = new Map(rules.map((r) => [r.address.toLowerCase(), r]));

  // The counterparty is the address that is NOT the user's wallet.
  // For incoming: the sender (from_address) is the counterparty.
  // For outgoing: the recipient (to_address) is the counterparty.
  const counterparty =
    event.direction === 'in' ? event.from_address : event.to_address;

  if (!counterparty) return null;

  const rule = ruleMap.get(counterparty.toLowerCase());
  if (!rule) return null;

  const name = rule.name ?? counterparty.slice(0, 10) + '…';
  return {
    label: rule.label,
    confidence: rule.confidence,
    method: 'counterparty',
    evidence: `Counterparty "${name}" matches saved rule (source: user correction)`,
  };
}
