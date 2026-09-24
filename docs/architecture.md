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

Labels: revenue, x402_income, expenses, x402_spend, treasury, internal_transfer, gas, refund, unknown

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
- API: structured reads for humans and agents (Fastify, localhost:3000)
- MCP: agent-to-agent access (later)

---

## Production Runtime (as of Sept 2026)

### Agent reasoning path

```
Telegram message
      ↓
apps/telegram/index.ts   (Telegraf bot, long-polling or webhook)
      ↓
src/agent/run.ts         (agentic loop, max 6 steps)
      ↓
OpenAI-compatible API    (model: gpt-4o default, configurable via AGENT_MODEL)
                         (endpoint: Bankr LLM gateway via AGENT_BASE_URL, or OpenAI directly)
      ↓
src/agent/tools.ts       (11 tools, all user-scoped, all hit PostgreSQL directly)
      ↓
PostgreSQL (Supabase)    (source of financial truth)
```

### Environment variables that control the LLM gateway

| Var | Purpose |
|-----|---------|
| `AGENT_LLM_KEY` | API key (preferred over OPENAI_API_KEY) |
| `OPENAI_API_KEY` | Fallback API key |
| `AGENT_BASE_URL` | Base URL for OpenAI-compatible gateway (e.g. Bankr). If set, also passes key as `X-API-Key` header. |
| `AGENT_MODEL` | Model ID. Default `gpt-4o`. |

### Available agent tools

| Tool | Write? | Description |
|------|--------|-------------|
| `get_cash_position` | — | Latest balance snapshot across all wallets |
| `get_books_summary` | — | P&L summary over N days |
| `get_recent_activity` | — | Recent transactions, filterable by label |
| `get_wallets` | — | All registered wallets with roles |
| `get_wallet_balance` | — | Latest balance for a specific address |
| `get_unknown_transactions` | — | Unclassified transactions |
| `get_transaction` | — | Full detail for one event |
| `apply_correction` | ✓ | Reclassify a transaction; optionally name the counterparty |
| `get_financial_brief` | — | Cash + P&L + open items + recent alerts |
| `get_alerts` | — | Recent alerts |
| `register_wallet` | ✓ | Add a new wallet to the watch list |

All tool calls are gated by `assertUserScoped(userId)` — cross-user access is architecturally impossible.

### Running processes on VPS

| Service | Entry point | Role |
|---------|-------------|------|
| `luca-worker` | `apps/worker/index.ts` | 60s poll: sync wallets → classify → take heartbeat snapshot → run alert detectors → deliver alerts + briefs |
| `luca-telegram` | `apps/telegram/index.ts` | Telegraf bot, handles commands + free-text agent + alert polling |
| `luca-api` | `apps/api/index.ts` | Fastify API, localhost:3000, used for MCP auth, the ops console and admin invites |

---

## Hermes (removed September 2026)

Luca no longer uses the Hermes runtime. On 2026-09-24 the runtime pieces were deleted: `hermes/config.yaml`, `hermes/.env.example`, the `hermes/luca/plugins/luca_core.py` plugin, `scripts/setup-hermes.sh`, and the `GET /users/resolve` API endpoint that only the plugin called. The TypeScript Telegraf bot (`luca-telegram`) is Luca's only chat runtime and calls `runAgent()` directly.

The Markdown files under `hermes/` (`SOUL.md`, `BOOTSTRAP.md`, `hermes/luca/*.md`, skills, cron and memory notes) are kept as Luca's written identity and operating reference. They are not loaded by any code; the agent's prompt is `prompts/system.md`.

**LUCA.md sections 4–9** describe the intended Hermes architecture. The current production implementation fulfills the same goals (Luca Core deterministic, LLM reasoning separate, PostgreSQL as truth) through a different mechanism: an embedded TypeScript agentic loop rather than a separate Hermes process.

---

## Security

- No private keys anywhere in the system
- No transaction signing in v1
- Secrets in env vars only, never in git
- Every financial query is scoped to the authenticated user
- Luca is read-only in v1 (no fund movement, no contract execution)

---

## Infrastructure

- **VPS:** 167.233.18.210 (Ubuntu 24.04), systemd services with linger enabled
- **Database:** Supabase PostgreSQL (remote), accessed via `DATABASE_URL`
- **Blockchain:** Base via Alchemy (`ALCHEMY_API_KEY`) with Blockscout fallback
- **LLM:** Bankr LLM gateway (or OpenAI) via `AGENT_BASE_URL` / `AGENT_LLM_KEY`
- **Frontend:** Not yet deployed (Phase 9 — Vercel)
