# Luca — Architecture

## Overview

Luca is a seven-layer financial agent system. Each layer has one job. No layer skips another.

```
Wallet Activity
      ↓
  Ingestion
      ↓
 Normalization
      ↓
 Classification
      ↓
    Ledger
      ↓
    Memory
      ↓
  Reporting
      ↓
 Interfaces (Telegram / API / MCP)
```

## Layers

### 1. Ingestion
- Reads on-chain activity for attached wallets
- Backfills historical data (30 days default)
- Streams new activity going forward
- Sources: Base RPC, Alchemy Transfers API, token transfer logs

### 2. Normalization
Converts raw chain data into a canonical financial event.

Every event includes:
- chain, wallet, hash, block_time
- from, to, asset, amount, usd_value
- direction (in/out), raw_payload

### 3. Classification
Assigns a books label to every normalized event.

Order of operations:
1. Deterministic rules (highest trust)
2. Pattern rules (recurring amounts, cadence)
3. Learned rules (from user corrections)
4. Model fallback (lowest trust, must return evidence + confidence)

Labels: revenue, x402_income, expenses, x402_spend, treasury, internal, gas, unknown

### 4. Ledger
Computes financial books and derived metrics.

Metrics:
- cash, net operating result, runway
- spend velocity (7d and 30d)
- unknown share, vendor concentration
- new counterparty count

### 5. Memory
Stores durable operator-specific truth.

Contents:
- wallet ownership and roles
- known counterparties and labels
- recurring vendors, user corrections
- materiality thresholds, reporting preferences

### 6. Reporting
- Daily brief (morning)
- Weekly brief
- Anomaly brief (triggered)
- Ad hoc explanations
- Evidence-backed answers

### 7. Interfaces
- Telegram Bot: primary human surface
- API: structured reads for humans and agents
- MCP: agent-to-agent access (later)

## Hermes Integration

Luca runs as a Hermes agent.

- Hermes is the reasoning layer
- Luca's tools are the action layer
- Telegram is the operator front door
- API/MCP is the agent front door

Hermes tools:
- get_books, get_brief, get_unknowns
- classify_event, label_counterparty
- get_runway, get_alerts, get_wallet_roles

## Runtime

### Development
- Local Mac, local Postgres, Telegram bot (polling mode)

### Production
- VPS, Postgres, Worker process, Bot process, Scheduler process

## Security
- No private keys in v1
- No signing in v1
- Secrets in env vars only
- GitHub holds code, not secrets
- Luca is read-only in v1
