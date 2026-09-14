# Luca

> Luca is the employee who keeps books on the wallets that work while you sleep.

Luca is a private financial agent for on-chain operators and autonomous agents. It watches your wallets, classifies activity into books, remembers your corrections, and briefs you like an employee — not a dashboard.

## What Luca Does

- Attaches to 1–5 wallets on Base
- Ingests and normalizes on-chain activity
- Classifies every event: revenue, expenses, internal, gas, unknown
- Remembers your corrections and learns from them
- Sends a daily brief via Telegram
- Alerts when something material changes
- Answers financial questions with evidence
- Serves humans (Telegram) and agents (API/MCP)

## What Luca Does Not Do (v1)

- Sign transactions
- Move funds
- Trade
- Depend on Zetta
- Maintain a public registry

## Stack

- Agent: Hermes
- Chain: Base (v1)
- Interface: Telegram Bot
- Database: Postgres
- Runtime: Mac (dev) → VPS (production)

## Quick Start

```bash
git clone https://github.com/danbuildss/luca
cd luca
cp .env.example .env
# fill in .env
npm install
npm run db:migrate
npm run dev
```

## Project Structure

```
luca/
├── LUCA.md              # Product constitution
├── apps/
│   ├── telegram/        # Telegram bot
│   ├── api/             # REST API
│   └── worker/          # Ingestion + classification worker
├── core/
│   ├── ingest/          # Chain data ingestion
│   ├── normalize/       # Canonical event format
│   ├── classify/        # Classification engine
│   ├── ledger/          # Books and metrics
│   ├── memory/          # Corrections and counterparties
│   ├── alerts/          # Alert engine
│   └── briefs/          # Brief generation
├── prompts/             # Hermes prompt files
├── db/                  # Schema and migrations
└── docs/                # Architecture and deployment
```

## Powered by $LUCA
