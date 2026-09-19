# NOTES.md — Luca Project Memory

Read this first every session. Never ask the owner to re-explain anything here.

---

## What Luca Is

Luca is a private financial agent for on-chain operators and autonomous agents.
It watches user-owned wallets on Base, classifies activity into books, remembers
corrections, and briefs the operator daily via Telegram.

**Tagline:** "The employee who keeps books on the wallets that work while you sleep."

**Core thesis:** We are not building "Hermes with a Luca prompt."
We are building **a financial system with Hermes as its intelligence layer.**
The corrected financial graph Luca builds about the operator is the moat — not the LLM.

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

## Pull Request

https://github.com/danbuildss/luca/pull/2 — tracks branch `claude/brave-pasteur-mayw5k`.
Push commits to this branch to update the PR. Do not open a new PR.

---

## Architecture

```
                     @AskLucaBot
                          │
                          ▼
                 ┌─────────────────┐
                 │  HERMES / LUCA  │
                 │  Agent Runtime  │
                 └────────┬────────┘
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
        ▼                 ▼                  ▼
  Luca Finance       Luca Memory       Luca Monitoring
     Skill              Layer               Engine
        │                 │                  │
        └─────────────────┼──────────────────┘
                          │
                          ▼
                 LUCA FINANCIAL CORE
              classifications + rules
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
          Database                  Bankr
  ledger / rules / reports      portfolio / prices /
   wallets / counterparties       crypto capabilities
             │
             ▼
       Base chain data
             │
             ▼
   Wallets / USDC / ETH / x402
```

**Hermes = brain/runtime. Bankr = financial tool. Luca's ledger = source of truth.**

---

## Product Loop

**Watch → Classify → Remember → Understand → Report → Alert**

Not trade. Not speculate. Not manage a portfolio. Not a generic crypto assistant.

The product reliably answers:
- "How much revenue came in this month?"
- "What did we spend this week?"
- "What happened to that 1,500 USDC?"
- "Is treasury going down faster than normal?"
- "What transactions don't you understand?"
- "Who are our biggest counterparties?"
- "Give me my financial brief."

---

## V1 Scope

| Area | V1 |
|---|---|
| Chain | Base |
| Assets | USDC + ETH |
| Interface | Telegram |
| Runtime | Hermes |
| Server | VPS |
| Financial tool | Bankr (read-only, IP-locked) |
| Storage | Luca-owned database (SQLite alpha → PostgreSQL beta) |
| Monitoring | Hermes cron + deterministic scripts |
| Execution | OFF |
| Wallet signing | OFF |
| Trading | OFF |
| Users | Owner first, private alpha, then beta |
| Zetta dependency | None |
| $LUCA dependency | None |

---

## Hermes Setup

Luca runs as a **dedicated Hermes profile**, not miscellaneous files in the default installation.

```bash
hermes profile create luca
```

Profile directory:
```
~/.hermes/profiles/luca/
├── SOUL.md
├── config.yaml
├── .env
├── memories/
├── skills/
│   ├── luca-finance/
│   ├── bankr/
│   └── ...
├── cron/
├── sessions/
└── logs/
```

- `SOUL.md` — who Luca is
- Skills/instructions — how Luca does financial work
- Database — financial truth
- Hermes `MEMORY.md` / `USER.md` — small durable agent context ONLY (never put financial history here)

---

## Luca Financial Core

The most important engineering piece. A service/script layer underneath Hermes that
converts raw blockchain activity into Luca's financial model. Hermes calls it through
the `luca-finance` skill.

When asked "revenue last 30 days", Hermes **queries Luca Core** — it does NOT ask
an LLM to re-guess from raw transactions.

```
luca-core/
├── src/
│   ├── wallets/
│   ├── ingestion/
│   ├── classification/
│   ├── counterparties/
│   ├── reports/
│   ├── alerts/
│   ├── bankr/
│   └── db/
├── migrations/
├── tests/
└── scripts/
```

---

## Stack

| Layer | Technology |
|---|---|
| Language | TypeScript / Node.js ≥20 |
| Agent runtime | Hermes (dedicated `luca` profile) |
| LLM | Bankr Agent API (Hermes) / Anthropic or OpenAI SDK (app code) |
| Chain | Base (v1 only) |
| Chain data | Alchemy (Base RPC + Transfers API) |
| Telegram | Telegraf ^4.16.3 / Hermes native Telegram adapter |
| Database | SQLite (alpha) → PostgreSQL (beta) |
| API framework | Fastify |
| Scheduler | Hermes cron (no-agent scripts where possible) |
| Logging | Pino |
| Blockchain lib | viem ^2.7.0 |

---

## Database Schema

Current file: `db/schema.sql` (single bootstrap SQL, no migration runner yet).

Full target schema:

| Table | Purpose |
|---|---|
| `users` | Luca principals (telegram_id, materiality_usd, timezone, brief_time) |
| `wallets` | Wallets owned/watched by user |
| `wallet_roles` | operations, treasury, personal, agent, revenue |
| `transactions` | Normalized blockchain activity |
| `classifications` | Luca's interpretation + confidence + method + evidence |
| `classification_rules` | Learned/custom rules |
| `counterparties` | Known addresses/entities |
| `balance_snapshots` | Historical balances |
| `alerts` | Detected financial events |
| `reports` | Generated briefs/reports |
| `sync_state` | Last indexed block/time |
| `corrections` | User corrections |
| `audit_log` | Changes Luca made to financial records |

Transaction record target fields:
```
tx_hash, chain, wallet, timestamp
from, to
asset, amount, usd_value
gas_cost, direction
classification, confidence
counterparty, counterparty_confidence
reason, evidence
user_corrected
```

**Multi-user rule:** Everything in Postgres must be keyed to `user_id`. Hermes MEMORY
holds Luca product knowledge only — never individual user financial data.

---

## Classification Engine

Nine categories:
```
revenue | expense | internal_transfer | treasury | gas
x402_income | x402_spend | refund | unknown
```

Classification layers (in order — LLM is last resort):
1. **Deterministic rules** — same-wallet transfers = internal, gas = gas, known x402 = x402
2. **Historical/user rules** — known counterparties from previous corrections
3. **Protocol/transaction evidence** — contract type, patterns, cadence
4. **LLM reasoning** — only for unresolved items, must return evidence + confidence

`unknown` is always a valid and visible answer.

Example deterministic rule:
```
wallet A belongs to Dan
wallet B belongs to Dan
A → B 500 USDC
= internal_transfer, confidence: high
```

---

## Corrections → Memory (the moat)

User corrections are durable and reusable:
- "That wallet belongs to me." → saved as wallet_role
- "Payments from this wallet are CORTX revenue." → saved as counterparty_rule
- "That wasn't an expense, I moved money to treasury." → corrects tx AND updates rule

Day 1: Luca understands ~60%.
Day 30: Luca understands wallets, counterparties, revenue sources, expenses, agents,
treasury structure, and operational patterns.

The corrected financial graph is the moat. Not the model.

---

## Bankr's Role

Installed as a Hermes skill. **Read-only, IP-allowlisted to VPS IP.**

Bankr can provide: ETH price, portfolio info, wallet balances, crypto research, market context.
Bankr cannot (in Luca): send USDC, swap, sign, submit transactions.

Config:
```
READ_ONLY = TRUE
IP_ALLOWLIST = VPS_IP
```

Bankr read-only keys return 403 on write endpoints — this is the safety layer.

---

## Blockchain Ingestion

Separate from Bankr. Deterministic Base transaction ingestion layer.

```
wallet added
  → backfill 30 days of historical transactions
  → normalize transactions
  → detect token transfers
  → calculate gas
  → store raw data (idempotent)
  → classify
  → update counterparty graph
  → update books
```

Then incrementally sync from last processed block/time. Never re-fetch the whole wallet.

---

## Monitoring Engine

Use Hermes cron + no-agent scripts. **Do not wake an LLM every minute.**

Most checks: `script → DB → rules`. Only escalate to Hermes/LLM when reasoning is needed.

| Frequency | Job |
|---|---|
| Frequent | Sync watched wallets |
| After new activity | Deterministic classification |
| After classification | Run alert rules |
| Periodic | Analyze unknowns/anomalies (LLM) |
| Daily | Financial brief |
| Weekly | Financial report |
| Monthly | Books summary |

---

## Alert Philosophy

**Silence is normal. Speak when something changed that matters.**

Examples:
```
$2,400 USDC left Operations.
This is 4.3× larger than your typical outgoing payment.
I can't match the recipient to a known counterparty.
Want me to investigate?
```

```
Treasury fell below $5,000.
Current balance: $4,732
30-day operating spend: $3,410
```

Alert types: large tx, new counterparty, spend spike, treasury floor, high unknown activity.

---

## Financial Briefs

Daily brief (short):
```
Luca — Daily Brief

Cash
$8,432 USDC / 0.42 ETH

Yesterday
Revenue       +$620
Expenses      -$184
Gas           -$7.41
Net           +$428.59

3 wallets active.

Attention
• $240 payment to a new counterparty
• $93 remains unclassified
```

Weekly report: revenue, expenses, net cash flow, treasury, gas, x402 economics,
largest counterparties, largest transactions, unknown activity, changes vs prior week.

---

## Telegram

`@AskLucaBot` is the primary interface. Natural language first — commands are shortcuts.

Users speak naturally:
- "Luca, give me my weekly books."
- "What did we spend yesterday?"
- "Why did treasury fall?"
- "Watch 0x..."
- "This wallet belongs to me."
- "Treat payments from 0x... as revenue."

---

## VPS Architecture

```
Ubuntu VPS
┌──────────────────────────────────┐
│ Dedicated luca Linux user        │
│                                  │
│ Hermes luca profile              │
│ Hermes Gateway (systemd)         │
│ Telegram adapter                 │
│ Luca Core                        │
│ Luca database                    │
│ Cron jobs                        │
│ Logs / Backup scripts            │
└──────────────────────────────────┘
  → Bankr (read-only, IP-locked)
  → LLM provider
  → Base chain data (Alchemy)
  → Telegram
```

Install Hermes:
```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes profile create luca
sudo hermes -p luca gateway install --system
```

Enable systemd linger for cron workers to survive gateway lifecycle.

---

## VPS Security

- SSH keys only, root SSH disabled
- Firewall enabled, only necessary ports open
- Automatic security updates
- Dedicated `luca` Linux user
- Hermes secrets in `.env`, never in code
- Bankr: read-only key, IP-locked to VPS
- Database not publicly exposed
- Daily encrypted backups
- Log rotation
- Secret rotation process
- Consider Docker terminal backend for agent isolation

---

## Build Stages (20 stages, in order — do not skip ahead)

1. **Luca identity** — lock SOUL.md, instructions, financial rules and terminology
2. **VPS** — production server, dedicated user, Hermes `luca` profile, gateway
3. **Telegram** — connect @AskLucaBot; allow only owner's Telegram ID
4. **Bankr** — install skill, read-only key, IP-lock to VPS
5. **Wallet registry** — register Base wallets, assign roles (ops, treasury, agent, personal)
6. **Ledger** — transaction ingestion, normalized USDC/ETH activity
7. **Classification** — 9 categories, confidence levels, deterministic rules first
8. **Corrections** — persistent, reusable, update classification rules
9. **Books** — revenue, expenses, gas, transfers, treasury, net flow, unknown
10. **Queries** — natural language questions query books, not recompute from LLM
11. **Monitoring** — continuous wallet sync via Hermes cron/no-agent scripts
12. **Alerts** — large tx, new counterparty, spend spike, treasury floor, high unknown
13. **Briefs** — daily, weekly, monthly auto-delivered in Telegram
14. **Reliability** — retries, stale-data detection, duplicate prevention, audit log
15. **Private alpha** — owner uses Luca every day, corrects everything wrong
16. **Private beta** — small number of operators, full user-scoped PostgreSQL
17. **Open source** — Hermes profile distribution + Luca Core on GitHub
18. **Luca Cloud** — hosted onboarding, isolated customer data, subscription billing
19. **More chains** — only after Base books are reliably correct
20. **Execution** — much later, with permissions/previews/limits/approval/audit trail

Current stage: **0 — no application code yet**. Next: Stage 1 (identity lock) → Stage 6 (ledger).

---

## V1 Shipped Definition

V1 is finished when this entire loop works AND survives a VPS restart with nothing lost:

```
Add wallet
  → Luca backfills activity
  → Builds the books
  → Classifies transactions
  → Surfaces unknowns
  → You correct Luca
  → Luca remembers
  → New transaction happens
  → Luca detects it
  → Updates books
  → Alerts if necessary
  → Daily/weekly report reflects it
```

---

## Success Metrics

| Metric | Goal |
|---|---|
| Transaction ingestion completeness | Effectively 100% |
| Duplicate transactions | 0 |
| Cross-user financial leakage | 0 |
| User corrections remembered | 100% where rule applies |
| Incorrect high-confidence classifications | Drive toward 0 |
| Unknown ratio | Decreases as Luca learns |
| Alert usefulness | High; minimal noise |
| Report reproducibility | Same ledger → same numbers |
| Server recovery | Automatic |
| Write access | 0 in V1 |

Most important metric: **How often is Luca right about what the money means?**

---

## Product Architecture (Full)

```
                    LUCA
                      │
        ┌─────────────┼─────────────┐
        │             │             │
      Web App      Telegram      MCP / API
        │             │           (later)
        └─────────────┼─────────────┘
                      │
                  Luca Core
                      │
                    Hermes
                      │
          Financial data + Bankr
```

Telegram and the web app are two interfaces to the same Luca. Not two products.

---

## Surfaces (by phase)

**Human:**
- Telegram — conversational, fastest
- Luca Web App — financial workspace

**Agent / Developer (later):**
- Luca MCP — agent-to-agent financial queries
- Luca API — structured reads

MCP unlocks: "What is the treasury balance?", "How much did we spend through x402 this week?" — Luca becomes financial intelligence infrastructure, not just an app. Earn it by getting the books right first.

---

## Website Split

**`luca...`** — marketing/discovery site. Understand what Luca is, security/privacy, docs, sign up.

**`app.luca...`** — Luca application. Connect wallets, books, activity, alerts, reports, talk to Luca.

### Landing page (minimal — not 15 sections)

Key sections only:
1. Hero: tagline + CTA + product UI preview in the hero
2. Live financial snapshot (shows Luca working)
3. Four pillars: WATCH / UNDERSTAND / REMEMBER / SPEAK
4. Surface switcher: Telegram / Web / MCP soon
5. Trust line: Private by default. Read-only by default. Open source.
6. CTA

Design reference: clarity and trust over dumping metrics. Current fintech direction is
dashboards that answer the operator's immediate question, not walls of charts.

### Web app navigation

| Page | Purpose |
|---|---|
| **Home** | Financial state + Luca brief |
| **Activity** | Every transaction + classification |
| **Books** | Revenue, expenses, transfers, gas, x402 |
| **Wallets** | Watched wallets + roles |
| **Reports** | Daily/weekly/monthly financial reports |
| **Alerts** | Important events Luca surfaced |
| **Luca** | Full conversation interface |
| **Settings** | Rules, thresholds, notifications, account |

### Home screen concept

NOT a crypto dashboard. Answers: "What is happening with my operation right now?"

```
Good morning.
Your operation is net +$1,204 this week.

Cash $12,840  |  Revenue +$3,291
Expenses -$1,994  |  Gas -$93  |  Unknown $184

──────────────────────────
Luca noticed
Treasury spending is 34% higher than your 30-day average.
Investigate →
──────────────────────────
Recent Activity
+$620   Revenue   USDC
-$124   Expense   USDC
-$14    Gas       ETH
──────────────────────────
Ask Luca anything...
[ What did we spend this week? ]
```

---

## Design Direction

**Mercury / Linear / Stripe restraint + AI employee. Not a trading app.**

- Black / off-white palette
- Very little accent color
- Great typography
- Monospace numbers
- Lots of whitespace
- Green ONLY when communicating healthy / confirmed / positive state
- No charts for the sake of charts
- No "AI Crypto Portfolio Dashboard 🚀" energy

Goal: financial infrastructure someone trusts with business information.
Trust judgments in fintech form from clarity and presentation — not visual gimmicks.

Dribbble search terms for reference: `AI finance dashboard`, `fintech SaaS dashboard`,
`financial operations dashboard`, `AI agent dashboard`, `treasury dashboard`,
`fintech landing page dark`, `accounting dashboard`

---

## 8 Areas of the Business

| Area | What Luca needs |
|---|---|
| **Product** | Agent, ledger, classification, monitoring |
| **Brand** | Identity, visual system, language |
| **Website** | Explain and convert |
| **App** | Actual financial workspace |
| **Trust** | Security, privacy, read-only positioning |
| **Docs** | How Luca works + self-hosting later |
| **Distribution** | X, demos, operator community |
| **Operations** | VPS, logging, uptime, backups |

---

## Founder Priorities (before worrying about scale)

1. **Use Luca on your own wallets every day.** Every misunderstanding = product feedback.
2. **Create visual identity now.** Wordmark, icon, typography, colors, screenshots, X banner, GitHub assets.
3. **Build the landing page before the full app.** Ship the page while the agent is still being built.
4. **Design the app before building every screen.** Figma: Home, Activity, Books, Wallets, Luca Chat, Onboarding — then build.
5. **Document the product publicly.** "How Luca classifies money", "Why inflow isn't revenue", "How Luca handles wallet permissions".
6. **Start showing the build on X.** Screenshots of briefs, catching unknown transactions, dashboard taking shape. Don't wait for perfect.
7. **Build trust aggressively.** Privacy page, security page, read-only statement, what is stored, architecture page.
8. **Find 5 actual operators.** Not 1,000 waitlist users. Five people running wallets/businesses/agents with this problem.

---

## Three Build Phases

### Phase 1 — Luca Alpha (current)
```
Brand identity → Landing page → Hermes + VPS → @AskLucaBot
→ Wallet ingestion → Books/classification → Owner's daily usage
```

### Phase 2 — Luca Private Beta
```
Web app → Wallet onboarding → Home dashboard → Activity + Books
→ Reports + Alerts → 5–10 external operators
```

### Phase 3 — Luca Platform
```
Postgres / multi-user → Luca Cloud → API → MCP
→ Self-hosted/open-source distribution → More chains
```

**Much later:** Controlled actions. Only after Luca reliably understands the money.

---

## Immediate Next Action (before more backend code)

One focused day on visual identity:
1. Collect ~10 reference screenshots from Dribbble
2. Narrow to one visual direction
3. Design Luca landing page
4. Design Luca app Home dashboard

Once those two feel right, everything else inherits the same system.
This is what makes Luca look like a financial software company, not "a Telegram bot Dan is working on."

---

## Open Source / Business Model

- **Luca Core** = open source Hermes profile distribution + financial engine
- **Luca Cloud** = hosted version (managed infra, isolated customer data, billing)
- Hermes profile distributions: package SOUL, skills, config as a Git repo; credentials/memory stay local

---

## Chart of Accounts

```
revenue | x402_income | expense | x402_spend | treasury | internal_transfer | gas | refund | unknown
```

(Updated from original — added `refund`, renamed `internal` to `internal_transfer`, split `expenses` from `expense`)

---

## Behavior Rules

- Precise, conservative, admit unknowns
- Never call inflow revenue without evidence
- Never confuse internal transfers with income
- Never spam — silence is a feature
- `unknown` is always valid and visible
- LLM inference is last resort, never first
- Hermes MEMORY never holds individual user financial data

---

## Hermes Files in Repo (hermes/)

- `SOUL.md` — agent identity
- `config.yaml` — LLM: bankr-agent, temp 0.2, 128k context; security: execution=false, read_only=true
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

## GitHub & Deployment Setup

- **GitHub repo:** `danbuildss/luca` — all code lives here
- **Production branch:** `claude/brave-pasteur-mayw5k` (PR #2 tracks it)
- **Local Mac:** Hermes installed — use for testing Luca profile and Telegram bot locally
- **Production:** VPS (Ubuntu) — all real deployment goes here, driven from GitHub
- **Deployment flow:** push to GitHub → SSH to VPS → `git pull && pm2 restart all` (or systemd)
- **Process manager:** systemd on VPS (not PM2 — keep consistent with design doc)

## CEO Plan Decisions (locked 2026-09-19)

Full plan: `~/.gstack/projects/danbuildss-luca/ceo-plans/2026-09-19-luca-build-in-public.md`

**Mode:** SELECTIVE EXPANSION — 6 features reviewed, 5 accepted, 1 skipped.

| Feature | Decision | Notes |
|---------|----------|-------|
| `/alias` command | SKIPPED | Label capture via counterparty alert reply only |
| `/runway` command | ACCEPTED | Treasury ÷ burn rate (7d/30d). Build LAST in Week 8 after books exist |
| New counterparty alert | ACCEPTED | State machine via `pending_counterparty_alerts` table, 48h timeout, 30-day re-alert |
| MCP server | ACCEPTED | 4 endpoints: `get_treasury_balance`, `get_recent_books`, `get_runway`, `can_afford` |
| Gas trend in daily brief | ACCEPTED | "Gas spend: $7.41 (↑40% vs last week)" |
| Solana support | CONDITIONAL | Must pass normalization spike (2-4h investigation) before building |

**New tables added to `db/schema.sql`:**
- `mcp_keys (key_hash, user_id, caller_name, created_at)` — MCP API key auth
- `pending_counterparty_alerts (id, user_id, counterparty_address, watched_wallet_address, telegram_message_id, sent_at, status, resolved_at)` — counterparty labeling state machine
- `balance_snapshots (wallet_id, user_id, asset, balance, snapshot_at)` — for /runway treasury
- Fixed `corrections` table: added `type[tx|counterparty]`, `counterparty_address`, `source_message`
- Added `provider` and `chain` to `sync_runs`

**Critical pre-code decisions (must lock in Gate A):**
1. Classification label enum: `revenue, expense, internal_transfer, treasury, gas, x402_income, x402_spend, refund, unknown` — TypeScript enum + DB CHECK constraint
2. Balance computation: use `balance_snapshots` (snapshot on every sync run)
3. Deployment runtime: systemd on VPS, not PM2
4. OPERATIONS.md rule: Markdown files (BOOKS.md, MEMORY.md) = Hermes context only. All corrections/counterparties/wallet state → Postgres exclusively
5. LLM circuit breaker: DB counter, $1/day cap, resets midnight UTC

## `/runway` Command Rules

- Treasury = USDC + USDC.e + DAI + USDT across all watched wallets for user_id
- Burn rate = 7-day and 30-day trailing averages
- Output: "At current burn: 14 weeks. Treasury: $12,400 USDC. Burn: $890/wk (7d avg) | $720/wk (30d avg)."
- Edge: burn = 0 → "No spend detected in lookback window — runway undefined."
- Edge: treasury = 0 → "⚠️ Treasury empty."
- **Prerequisite:** Books layer must exist. Build LAST in Week 8.

## New Counterparty Alert Rules

- Fires when: address not in `counterparty_rules` for that user_id transacts with watched wallet
- Template: "⚠️ New counterparty: 0xabc…def sent $420 USDC to [wallet-name]. What should I call this? Reply with a label (e.g. 'Vendor: AWS', 'Revenue: CORTX') or 'skip'."
- Wallet-name MUST be sanitized (strip non-alphanumeric) before embedding in message — prompt injection risk
- Reply creates counterparty rule. No reply in 48h → `status='timed_out'`. Re-alert 30 days from `sent_at`.
- First-time senders only per user_id.
- After label: "Got it. 0xabc…def is now labeled 'Vendor: AWS'. I'll apply this to future transactions."

## MCP Server Auth Model

- **Distribution:** `MCP_KEY_<CALLER_NAME>=<token>` in `.env.production` (how keys are handed out)
- **Runtime validation:** hash the token, look up `key_hash` in `mcp_keys` table → get `user_id`
- **The env var is NOT queried at runtime** — only used to distribute keys to callers
- **Secondary defense:** IP allowlist (nginx level)
- **All endpoints:** enforce `user_id` scoping — zero cross-user financial leakage
- **`lookback_days` cap:** 365 days max; return 400 if exceeded

## Build Log

| Date | What was done |
|---|---|
| 2026-09-19 | Created NOTES.md (project memory). No code built yet. Established session workflow. PR #2 opened. |
| 2026-09-19 | Added gstack (20 skills) and jakubkrehel/skills (11 UI skills) to .claude/skills/. |
| 2026-09-19 | Full architecture document reviewed and captured in NOTES.md. Product thesis locked. |
| 2026-09-19 | Product/startup layer captured: website split, app nav, design direction, 8 business areas, 3 build phases, founder priorities. |
| 2026-09-19 | CEO plan review complete (SELECTIVE EXPANSION mode). 5 features accepted, 1 skipped. Schema updated: 4 new tables, corrections table fixed, /runway added to COMMANDS.md. |
