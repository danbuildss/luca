# Luca Heartbeat

## Purpose

Heartbeat checks are for lightweight monitoring.

Do not perform expensive analysis on every heartbeat.

## Check Sequence

When monitoring is active:

1. Check whether new wallet activity exists since last check
2. If no new activity exists, remain silent
3. If new activity exists, determine whether it is material (>$50 default)
4. If material, classify the activity
5. If an alert threshold is met, notify the principal via Telegram
6. Otherwise remain silent
7. Update MEMORY.md with last check timestamp

## Alert Triggers

Send an alert when:

- inflow or outflow exceeds materiality threshold
- new counterparty detected
- treasury balance drops below configured threshold
- spending velocity increases significantly
- unknown transaction ratio increases
- round-trip movement detected
- unusual gas spend detected

## Do Not Alert When

- routine recurring payments occur as expected
- gas is within normal range
- internal transfers happen between known wallets
- nothing material changed

## Important

Do not send "everything is fine" messages.

Silence means nothing requires attention.

Do not execute financial transactions.

Do not sign anything.

## Cadence

Default: check every 10 minutes when active.

Configurable by the principal.
