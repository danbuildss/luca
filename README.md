# Luca

> Luca is the employee who keeps books on the wallets that work while you sleep.

Luca is a private financial agent for on-chain operators. It watches your Base wallets, classifies every transaction into books, remembers your corrections, and briefs you like an employee — not a dashboard.

## What Luca Does

- Attaches to 1–5 wallets on Base
- Ingests and normalizes on-chain activity every 60 seconds
- Classifies every event: revenue, expenses, internal transfer, gas, unknown
- Remembers your corrections and applies them to future transactions
- Sends a daily brief via Telegram
- Alerts when something material changes (balance drop, spending spike, new counterparty)
- Answers financial questions with evidence via the Telegram bot

## What Luca Does Not Do (v1)

- Sign transactions
- Move funds
- Trade
- Depend on Hermes or any external agent runtime
- Maintain a public registry

## Stack

- **Bot:** Telegraf (TypeScript)
- **Agent reasoning:** OpenAI SDK → Bankr LLM gateway (configurable via `AGENT_BASE_URL`)
- **Chain:** Base via Alchemy, Blockscout fallback
- **Database:** Supabase (PostgreSQL)
- **Runtime:** VPS (Ubuntu 24.04) — systemd services

## Running Services

| Service | Entry point | Role |
|---------|-------------|------|
| `luca-worker` | `apps/worker/index.ts` | 60s cycle: sync → classify → alert → heartbeat |
| `luca-telegram` | `apps/telegram/index.ts` | Telegram bot, free-text agent, commands |
| `luca-api` | `apps/api/index.ts` | Fastify API, localhost:3000 |

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | ✓ | Supabase PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | ✓ | Telegram bot token |
| `ALCHEMY_API_KEY` | ✓ | Base RPC + transfer indexing |
| `AGENT_LLM_KEY` | ✓ | LLM API key (Bankr or OpenAI) |
| `AGENT_BASE_URL` | — | Bankr gateway base URL (omit for OpenAI direct) |
| `AGENT_MODEL` | — | Model ID — default `gpt-4o` |

## Setup

```bash
git clone https://github.com/danbuildss/luca
cd luca
cp .env.example .env
# fill in .env
bun install
bun run db:migrate
bun run dev
```

## Project Structure

```
luca/
├── LUCA.md              # Product constitution
├── apps/
│   ├── telegram/        # Telegram bot
│   ├── api/             # REST API (Fastify, localhost:3000)
│   └── worker/          # Sync + classification worker
├── src/
│   ├── agent/           # Agentic loop + tools
│   ├── alerts/          # Alert engine and detectors
│   ├── heartbeat/       # Financial heartbeat snapshots
│   ├── classify/        # Classification engine
│   └── ingest/          # Chain ingestion
├── migrations/          # PostgreSQL migrations (run in order)
├── prompts/             # System prompt
├── scripts/             # Ops and audit SQL scripts
└── docs/                # Architecture
```
