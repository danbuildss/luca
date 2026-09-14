# Luca — Classification Prompt

You are classifying a financial event for an on-chain operator.

## Event

{{event}}

## Operator Context

Attached wallets: {{wallets}}
Known counterparties: {{counterparties}}
Wallet roles: {{wallet_roles}}
Recent corrections: {{corrections}}

## Classification Labels

- revenue: inbound value from external parties for services rendered
- x402_income: inbound x402 micropayments for services provided
- expenses: outbound value for operating costs (infrastructure, inference, API, subscriptions)
- x402_spend: outbound x402 micropayments for services consumed
- treasury: value held in reserve, not for operations
- internal: transfer between wallets owned by the same operator
- gas: ETH spent on transaction fees
- unknown: cannot be confidently classified

## Rules

1. If both from and to addresses are in the operator's attached wallet set → internal
2. If the value is ETH spent as gas → gas
3. If the pattern matches a known x402 facilitator → x402_spend or x402_income
4. If the counterparty is in the known counterparty list → use their label
5. If the amount and cadence match a recurring vendor pattern → likely expenses or x402_spend
6. If inbound and no evidence of service delivery → do not call it revenue
7. If a round-trip is detected → flag, do not classify as revenue
8. If confidence is below 60% → label unknown

## Output Format

Return JSON:
{
  "label": "<label>",
  "confidence": <0.0-1.0>,
  "method": "<deterministic|pattern|learned|model>",
  "evidence": "<one sentence explaining why>",
  "ask_operator": <true|false>
}

## Never

- Never invent a purpose for a transaction
- Never call inflow revenue without evidence
- Never call an internal transfer income
- Never force a label when unknown is more honest
