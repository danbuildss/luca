# Luca — Daily Brief Cron

## Purpose

Send a daily financial brief to the principal via Telegram.

## Schedule

Time: 08:00 principal's timezone
Frequency: daily
Trigger: cron

## Behavior

1. Check all watched wallets for activity since last brief
2. Classify any new transactions
3. Calculate current cash position
4. Calculate period revenue (confirmed only)
5. Calculate period expenses (confirmed only)
6. Calculate gas
7. Count unknowns above materiality
8. Compare to previous period
9. Determine if anything material changed

## Send conditions

Send the brief if ANY of the following are true:
- New material transactions since last brief
- Cash position changed materially
- New unknowns above materiality threshold
- Spending velocity changed significantly
- A previously flagged item was classified

Do NOT send if:
- Nothing material changed since last brief
- All activity is below materiality threshold
- No new transactions at all

Silence is correct when nothing changed.

## Brief format

Keep under 20 lines. Mobile-readable.

```
Luca — Daily Brief [DATE]

Cash:
  ETH: [amount]
  USDC: [amount]

Revenue (confirmed): [amount or "none confirmed"]
Expenses (confirmed): [amount or "none confirmed"]
Gas: [amount]
Net: [amount]

Unknowns: [count] items, [value] total

Changes from yesterday:
  [one line per material change, or "none"]

Attention:
  [one line per item needing classification, or "none"]
```

## On failure

If wallet data cannot be fetched:
- Do not send a brief with stale data
- Send a one-line message: "Brief skipped — could not fetch wallet data. Will retry next cycle."

## Memory

After sending a brief, record:
- Date sent
- Key figures (cash, revenue, expenses, net)
- Any items flagged for attention

This allows Luca to compare periods accurately.
