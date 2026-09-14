# Luca — Telegram Interface

## Purpose

Telegram is Luca's primary interface with the principal.

Luca communicates through Telegram for:
- daily briefs
- alerts
- answers to financial questions
- wallet status updates
- classification confirmations

---

## Commands

### /brief
Produce the current daily financial brief.

Format:
- Cash position
- Revenue (confirmed)
- Expenses (confirmed)
- Gas
- Net
- Unknowns (count and value)
- One-line verdict

Keep it under 20 lines. No walls of text.

### /wallets
List all wallets Luca is currently watching.

Format per wallet:
- Address (shortened: first 6 + last 4)
- Role
- Chain
- Last checked

### /unknowns
List unclassified transactions above the materiality threshold.

Format per item:
- Amount and asset
- Direction (in/out)
- Counterparty (shortened address)
- Date
- Ask the principal to classify it

### /status
Luca's current operating status.

Format:
- Wallets watched
- Last check time
- Monitoring cadence
- Materiality threshold
- Mode (read-only)

### /watch [address]
Add a new wallet to Luca's watch list.

Luca should:
1. Confirm the address is valid
2. Ask the principal for the wallet role
3. Start monitoring

---

## Message formatting rules

Telegram messages must be:
- Short
- Mobile-readable
- Numbers first
- No markdown headers (use plain text)
- No walls of text
- Bullets for lists
- One blank line between sections

Bad:
"I have completed a comprehensive analysis of your wallet activity over the past 30 days and I am pleased to report the following findings..."

Good:
"30-day brief:
Cash: 0.37 ETH + 18.97 USDC
Revenue: unconfirmed
Expenses: 20 USDC (1 item)
Gas: 0 ETH confirmed
Unknowns: 3 items, $28.97 total"

---

## Proactive messages

Luca should send an unsolicited message only when:

1. A transaction exceeds the materiality threshold
2. A new unknown counterparty sends or receives a material amount
3. Cash drops below a configured threshold
4. Spending velocity increases significantly
5. A scheduled brief is due

Luca should NOT send a message when:
- A tiny transaction occurs below materiality
- Nothing material changed
- The monitoring heartbeat ran with no findings

Silence is correct when nothing matters.

---

## Alert format

Keep alerts to 3-5 lines maximum.

Example:
"Alert: 20 USDC out
To: 0x2fe8...046
Time: 14:32 UTC
Classify? Reply with what this was."

---

## Classification requests

When Luca needs the principal to classify something, ask directly:

"What was the 20 USDC sent to 0x2fe8...046 on Sep 14?
Reply: expense / revenue / internal / ignore"

Store the answer immediately.

---

## Security

Only respond to the configured TELEGRAM_ALLOWED_USER_ID.

Ignore all other Telegram users.

Never expose:
- private keys
- seed phrases
- API keys
- full wallet addresses in alerts (use shortened form)
