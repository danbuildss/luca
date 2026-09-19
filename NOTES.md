# NOTES.md — Luca Project Memory

Read this first every session. Never ask the owner to re-explain anything here.

---

## What Luca Is

Luca is a private financial agent for on-chain operators and autonomous agents.
It watches user-owned wallets on Base, classifies activity into books, remembers
corrections, and briefs the operator daily via Telegram.

**Tagline:** "The employee who keeps books on the wallets that work while you sleep."

---

## Session Workflow

1. Read NOTES.md first
2. Confirm branch: `git branch --show-current` → always work on `claude/brave-pasteur-mayw5k`
3. Understand what's already done before touching anything
4. Make changes → verify → commit → push to branch
5. Never auto-create a PR unless explicitly asked
6. After any build: update NOTES.md with what was built and decisions made, then commit + push it

---

## Branch

`claude/brave-pasteur-mayw5k`

---

## Current State (as of 2026-09-19)

**The repository is specification-first. No application code exists yet.**

What exists:
- `LUCA.md` — product constitution (wedge, scope, accounting rules, go-live criteria)
- `README.md` — project overview (marked as spec-only)
- `SETUP.md` — Hermes setup guide (manual steps, not automated)
- `NOTES.md` — this file (project memory, created this session)
- `db/schema.sql` — Postgres schema (single bootstrap file, no migration runner)
- `hermes/` — Hermes agent profile (SOUL.md, config.yaml, luca/ identity files, memories/, skills/)
- `prompts/` — LLM prompt templates (brief.md, classify.md, investigate.md, system.md)
- `docs/` — architecture.md, build-gap-analysis.md, deployment.md, operating-rules.md
- `package.json` — dependencies declared, referenced entry points don't exist
- `.env.example` — env var reference

What does NOT exist yet:
- `apps/` (telegram bot, REST API, worker)
- `core/` (ingest, normalize, classify, ledger, memory, alerts, briefs)
- `scripts/` (migrate.js, reset.js, backfill.ts, test-wallet.ts)
- `tsconfig.json`, ESLint config
- Any tests or CI

---

## Stack

| Layer | Technology |
|---|---|
| Language | TypeScript / Node.js ≥20 |
| Agent framework | Hermes (local, runs on Mac → VPS) |
| LLM | Bankr Agent API (in Hermes) / Anthropic SDK or OpenAI SDK (in app code) |
| Chain | Base (v1 only) |
| Chain data | Alchemy (Base RPC + Transfers API) |
| Telegram | Telegraf ^4.16.3 |
| Database | Postgres 16 |
| API framework | Fastify |
| Scheduler | node-cron |
| Logging | Pino |
| Blockchain lib | viem ^2.7.0 |

---

## Database Schema (db/schema.sql)

Tables (all user-scoped):
- `users` — telegram_id, materiality_usd, timezone, brief_time
- `wallets` — user_id, address, chain, label
- `wallet_roles` — ops, treasury, payments_in, expenses, cold
- `transactions` — raw on-chain data
- `normalized_events` — canonical event format
- `classifications` — label + method (deterministic/pattern/learned/model) + confidence + evidence
- `counterparty_rules` — user-specific address labels
- `memory_entries` — durable wallet_role/counterparty/vendor/threshold/preference
- `corrections` — user corrections (old_label → new_label)
- `briefs` — daily/weekly/anomaly brief records
- `alerts` — new_counterparty/spend_spike/treasury_floor/round_trip/unknown_high
- `watch_jobs` — per-wallet sync status
- `sync_runs` — ingestion run log

Note: Single `db/schema.sql` file. No migration runner yet. Must add `scripts/migrate.js`.

---

## Chart of Accounts

`revenue` | `x402_income` | `expenses` | `x402_spend` | `treasury` | `internal` | `gas` | `unknown`

---

## Classification Order (must not be changed)

1. Deterministic rules (same wallet set = internal, gas = gas, known x402 = x402)
2. Pattern rules (recurring amounts, cadence, repeated counterparties)
3. Learned rules (from user corrections)
4. Model fallback (only for unresolved items — must return evidence + confidence)

---

## Behavior Rules

- Be precise, conservative, admit unknowns
- Never call inflow revenue without evidence
- Never confuse internal transfers with income
- Never spam the operator — silence is a feature
- `unknown` is a valid and visible output

---

## Hermes Profile (hermes/)

- `SOUL.md` — agent identity
- `config.yaml` — LLM: bankr-agent, temp 0.2, 128k context; memory path; telegram config; security: execution=false, read_only=true
- `luca/` — IDENTITY.md, RULES.md, OPERATIONS.md, SECURITY.md, TELEGRAM.md, COMMANDS.md, ALERTS.md, BOOKS.md, HEARTBEAT.md, GOALS.md, AGENTS.md
- `memories/` — MEMORY.md, USER.md
- `skills/luca-finance/` — SKILL.md

---

## Env Variables Required

```
DATABASE_URL
TELEGRAM_BOT_TOKEN
ALCHEMY_API_KEY
BASE_RPC_URL
ANTHROPIC_API_KEY  (or OPENAI_API_KEY)
BASESCAN_API_KEY
NODE_ENV / PORT / LOG_LEVEL
```

Optional: `REDIS_URL`, `QUICKNODE_BASE_RPC`

---

## Next Build Target (from build-gap-analysis.md)

Thin end-to-end vertical slice:
1. Register one Base wallet
2. Backfill USDC and ETH activity via Alchemy
3. Normalize and persist events idempotently
4. Classify deterministic cases (internal, gas)
5. Expose unknowns, accept corrections
6. Calculate reproducible books
7. Produce one Telegram brief from stored data
8. Survive restart without losing memory

### Phase order:
- Phase 1: scaffolding — tsconfig, scripts/migrate.js, core/db.ts, project structure
- Phase 2: ingestion — core/ingest (Alchemy), core/normalize, scripts/backfill.ts
- Phase 3: classification — core/classify (deterministic first)
- Phase 4: ledger — core/ledger (books + metrics)
- Phase 5: Telegram bot — apps/telegram
- Phase 6: worker + cron — apps/worker
- Phase 7: API — apps/api
- Phase 8: memory + corrections — core/memory
- Phase 9: alerts + briefs — core/alerts, core/briefs

---

## Go-Live Criteria

Luca is ready when it can:
- Ingest 30 days of Base wallet history
- Classify obvious flows correctly
- Persist user corrections
- Produce a useful morning brief
- Send only meaningful alerts
- Survive restarts without losing memory
- Answer "did I make money?" with evidence

---

## Key Decisions Made

- v1 is Base-only (ETH + USDC)
- No Zetta dependency
- Read-only — no signing, no transfers, no trading
- Hermes is the agent runtime; application code is separate
- DB is the source of truth (not Markdown files in memory)
- Single-file schema today; migrate to versioned migrations before production
- LLM inference is last resort, not first
- `unknown` is always surfaced, never hidden

---

## Surfaces

- Telegram — primary human interface
- API (Fastify) — structured reads for humans and agents
- MCP — agent-to-agent (later, not v1)
- Dashboard — optional, later

---

## Pull Request

https://github.com/danbuildss/luca/pull/2 — tracks branch `claude/brave-pasteur-mayw5k`.
Push commits to this branch to update the PR. Do not open a new PR.

---

## Build Log

| Date | What was done |
|---|---|
| 2026-09-19 | Created NOTES.md (project memory). No code built yet. Established session workflow. PR #2 opened. |
