# Luca — Alert Rules

## Philosophy

Alerts should be rare and useful.

An alert that fires too often trains the principal to ignore it.

An alert that never fires is useless.

Default: silence unless something materially changed.

---

## Alert triggers

### 1. Large inflow
Threshold: above materiality ($50 default)
Trigger: any single inflow above threshold from an unknown counterparty
Message: amount, asset, counterparty (shortened), time, ask to classify

### 2. Large outflow
Threshold: above materiality ($50 default)
Trigger: any single outflow above threshold
Message: amount, asset, counterparty (shortened), time, ask to classify

### 3. New counterparty — material
Trigger: first-ever transaction with a counterparty above materiality
Message: new address, direction, amount, ask to label

### 4. Spending spike
Trigger: 7-day spend exceeds 2x the previous 7-day spend
Message: current spend, previous spend, top expense items

### 5. Cash below threshold
Trigger: USDC or ETH balance drops below configured minimum
Default minimum: not set — principal must configure
Message: current balance, recent outflows

### 6. High unknown ratio
Trigger: more than 30% of 7-day value is unclassified
Message: unknown count, unknown value, top unknown items

### 7. Unusual gas
Trigger: gas spend in 24h exceeds 3x the 30-day daily average
Message: gas amount, transaction count, flag for review

### 8. Round-trip suspicion
Trigger: funds leave and return within 24h from same counterparty
Message: amounts, counterparty, timing, ask to explain

### 9. x402 anomaly
Trigger: x402 income drops to zero for 48h after consistent activity
Message: last x402 income time, previous daily average

---

## Non-triggers (stay silent)

- Transactions below materiality threshold
- Known classified counterparties with expected activity
- Internal transfers between confirmed principal wallets
- Heartbeat ran with no findings
- Gas below normal range
- Tiny token inflows (airdrops, dust)

---

## Alert format

Maximum 5 lines per alert.

Line 1: what happened (amount + asset + direction)
Line 2: counterparty (shortened address or known label)
Line 3: time
Line 4: current classification
Line 5: action request (classify? investigate? confirm?)

Example:

Alert: 150 USDC received
From: 0x0ab1...2e5
Time: 09:14 UTC Sep 14
Classification: unknown
What was this? Reply: revenue / refund / internal / ignore

---

## Escalation

If the same item remains unclassified after 3 days, surface it again in the next brief.

Do not spam daily. Surface once, then include in weekly unknowns report.

---

## Silence confirmation

If nothing material happened during a heartbeat check, do not send any message.

Do not send "all clear" or "nothing to report" messages.

Silence means nothing requires attention.
