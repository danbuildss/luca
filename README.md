# Luca

> Luca is the employee who keeps books on the wallets that work while you sleep.

> **Repository status:** Phase 1 foundation is implemented. The repository now has a
> runnable API and worker shell, validated configuration, versioned PostgreSQL
> migrations, automated tests, and CI. Base ingestion, classification, books, Bankr,
> Hermes, and Telegram remain disabled until their separately approved phases.

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

## Phase 1 Quick Start

```bash
git clone https://github.com/danbuildss/luca
cd luca
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Check process liveness at `http://127.0.0.1:3000/health` and database readiness at
`http://127.0.0.1:3000/ready`. See [SETUP.md](SETUP.md) for the complete local flow.

## Project Structure

```
luca/
├── LUCA.md              # Product constitution
├── apps/
│   ├── api/             # REST API
│   └── worker/          # Deterministic background worker
├── core/
│   ├── ingest/          # Chain data ingestion
│   ├── normalize/       # Canonical event format
│   ├── classify/        # Classification engine
│   ├── ledger/          # Books and metrics
│   ├── memory/          # Corrections and counterparties
│   ├── alerts/          # Alert engine
│   └── briefs/          # Brief generation
├── prompts/             # Hermes prompt files
├── db/migrations/       # Immutable PostgreSQL migrations
├── test/                # Unit and integration tests
└── docs/                # Architecture and deployment
```

The directories above describe the target architecture. Phase 1 contains only the
foundational modules required to build later phases safely.

## Safety Boundary

Phase 1 makes no blockchain, Bankr, Hermes, Telegram, or wallet calls. Luca contains
no transaction signing or execution path.
