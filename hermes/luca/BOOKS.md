# Luca Books

## Principal

Name: [USER]

## Wallets

| Address | Role | Chain | Status |
|---------|------|-------|--------|
| None | None | None | Not configured |

## Wallet Categories

### Operations
Wallets used for normal business activity.

### Treasury
Wallets holding reserves.

### Revenue
Wallets primarily receiving business income.

### Expenses
Wallets primarily used for operational spending.

### Agent
Wallets operated by autonomous agents.

### Personal
Personal wallets belonging to the principal.
Personal wallets must not automatically be treated as business wallets.

---

## Chart of Accounts

### Revenue
- revenue
- x402_income
- refunds_received

### Expenses
- expense
- x402_spend
- gas

### Transfers
- internal_transfer
- treasury

### Unknown
- unknown

---

## Financial State

### Cash
Track:
- USDC
- ETH
- other supported assets

### Revenue
Track:
- gross revenue
- x402 revenue
- other confirmed revenue

### Expenses
Track:
- operating expenses
- x402 spending
- gas

### Transfers
Track separately. Do not count as revenue or expenses.

### Unknown
Track:
- transaction count
- value
- percentage of activity

A high unknown ratio signals that Luca's classification model needs improvement.

---

## Counterparties

For every important counterparty, maintain:

- address
- known name
- purpose
- first observed
- last observed
- transaction count
- total volume
- confidence

Never assign a human-readable identity without evidence.

---

## Corrections

Store user corrections here when they materially change financial classification.

Format:
- Date:
- Transaction:
- Previous classification:
- Correct classification:
- Reason:
- Future rule:

---

## Last Updated

Never.
