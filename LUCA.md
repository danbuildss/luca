# LUCA — Master Product & Engineering Direction

## 1. What Luca Is

Luca is a **private financial agent for on-chain operators**.

**Positioning:** Luca watches your wallets, keeps your books, remembers your financial context, and tells you what matters.

**Long-term vision:** The financial employee for on-chain operations.

**Tagline:** The employee who keeps books on the wallets that work while you sleep.

Luca is not just a chatbot. Luca should eventually behave like a persistent financial employee that understands an operator's financial environment.

## 2. Luca's Core Job

The core loop is:

```
Watch → Understand → Remember → Report → Alert
```

Later: → Act. But execution is NOT part of V1.

Luca should answer questions such as:
- How much revenue came in this month?
- What did we spend this week?
- Why did spending increase?
- Why did treasury decrease?
- What happened to this 1,500 USDC transaction?
- Which transactions are still unknown?
- How much did my agents spend?
- Who are my largest counterparties?
- What changed financially this week?
- Give me my financial brief.

Luca should also proactively tell the operator when something materially changes.

## 3. Initial Customer

**Primary customer:** On-chain operators. Especially people operating crypto products, protocols, agent businesses, multiple wallets, autonomous agent wallets, x402 services, USDC-heavy operations, or on-chain treasury.

**Initial ICP:** Someone operating roughly 1–20 wallets/agent wallets who currently has difficulty understanding what all the financial activity actually means.

Do not build Luca as a retail portfolio tracker. Do not target traders first. Do not build for everybody.

## 4. The Most Important Architectural Principle

**Luca is the product. Hermes is a runtime.**

Do NOT architect the product as: `Hermes → Luca`

Architect it as: `Luca → Hermes runtime`

The canonical source of Luca must be `github.com/danbuildss/luca` — NOT `~/.hermes`.

Anything that makes Luca unique should ultimately live in or derive from the Luca repository. Hermes-specific configuration can exist, but the product's intellectual property and business logic must not become trapped inside one agent framework.

## 5. Final High-Level Architecture

```
                      LUCA

             ┌─────────┴─────────┐
             │                   │
        Interfaces          Agent Runtime
             │                   │
    ┌────────┼────────┐        Hermes
    │        │        │           │
Telegram    Web     API/MCP       │
                      later       │
             │                    │
             └─────────┬──────────┘
                       │
                 Luca Tool Layer
                       │
                       ▼
                  LUCA CORE
                       │
        ┌──────────────┼──────────────┐
        │              │              │
    Ledger        Classification    Monitoring
        │              │              │
        ├──────────────┼──────────────┤
        │              │              │
    Reports          Memory         Alerts
        │              │              │
        └──────────────┼──────────────┘
                       │
                   PostgreSQL
                       │
         ┌─────────────┴─────────────┐
         │                           │
    Base / Alchemy                 Bankr
```

**Critical boundaries:**
- Hermes = agent runtime
- Luca Core = deterministic financial engine
- PostgreSQL = source of financial truth
- Alchemy/Base = primary blockchain data
- Bankr = additional financial/crypto capability
- Telegram/Web = interfaces

## 6. Do Not Make Luca Framework-Dependent

Hermes is Luca's first production agent runtime. Use Hermes now.

Do NOT simultaneously build Hermes runtime + eve runtime + custom agent runtime.

However, Luca Core must not depend deeply on Hermes internals. The goal:

```
Luca Core
    │
    ├── works without Hermes
    │
    └── exposes deterministic functions/API

Hermes
    │
    └── consumes Luca Core
```

If Luca switches runtime someday, we should not need to rewrite ingestion, ledger, classifications, database, financial rules, reports, alerts, or wallet data.

## 7. Vercel / eve Direction

Do NOT migrate Luca to eve right now. Eve is interesting and should be monitored (filesystem-first agents, TypeScript, skills, tools, channels, schedules, durable workflows, self-hosting, Vercel deployment), but it is still evolving.

Later we can create a small prototype:
```
Luca Core
    │
    ├── Hermes adapter
    │
    └── eve prototype
```

Until that experiment provides strong evidence: **Hermes remains Luca's runtime.** Do not spend engineering time creating runtime abstractions yet.

## 8. Hermes' Role

**Hermes handles:** reasoning, Luca's personality, skills, tools, conversations, sessions, Telegram gateway, agent-level memory, scheduled agent jobs, background reasoning, eventual MCP consumption, model provider integration.

**Hermes does NOT own:** Luca's ledger, wallet transaction history, accounting truth, classifications database, balance history, user-specific financial records, counterparty graph, financial calculations. Those belong to Luca Core/PostgreSQL.

## 9. Luca Hermes Profile

Production Luca should run as a dedicated Hermes profile named `luca` — not the global/default profile.

It should have isolated config, `.env`, SOUL, skills, sessions, memories, cron, Telegram token, and gateway state.

The existing Luca currently running on the Mac should NOT simply be recreated manually. Use Hermes' profile migration/export/import functionality to move the existing Luca identity to the VPS. Credentials should be configured fresh on the server.

## 10. SOUL

**Identity:** You are Luca. You are a private financial agent for on-chain operators. You are not a generic assistant, trading bot, crypto influencer, public market analyst, investment recommendation bot, or portfolio speculation bot. You are a financial employee.

**Personality:** Precise, calm, conservative, skeptical, observant, direct, evidence-driven, private, comfortable saying "unknown".

No hype. No fake certainty. No unnecessary crypto language. No invented financial context.

**Core principle:** Being correct is more important than appearing intelligent.

## 11. Financial Rules

These are non-negotiable:
- Incoming transaction ≠ revenue automatically
- Outgoing transaction ≠ expense automatically
- If two wallets belong to the same operator: `internal_transfer` — not revenue/expense
- Treasury movements remain separate from operating revenue and expenses
- Gas is a real operating cost
- x402 income/spend should be identified only when evidence supports it
- Unknown is valid — never invent transaction purpose, counterparties, revenue, expenses, wallet ownership, or financial figures

Every meaningful inference should distinguish: observed fact / Luca classification / Luca inference / user-provided information.

## 12. Canonical Transaction Classifications

V1:
```
revenue
expense
internal_transfer
treasury
gas
x402_income
x402_spend
refund
unknown
```

Do not unnecessarily expand this taxonomy initially.

## 13. Classification Hierarchy

Use this order:
1. Deterministic evidence (owned wallet → owned wallet = internal transfer; network fee = gas; explicitly mapped x402 flow = x402)
2. Explicit user rules
3. Known counterparties
4. Historical learned patterns
5. Protocol/transaction evidence
6. Model inference — LLM inference is LAST

Do not let an LLM freely reinterpret the ledger every time a question is asked.

## 14. Confidence

Classifications need: label + confidence + evidence/reason.

Use: high / medium / low.

Low-confidence financial interpretations should remain clearly uncertain. When confidence is insufficient: `unknown` is preferred.

## 15. Corrections Are Part of Luca's Moat

Example: Luca says `$500 → expense`. User says `No. That wallet belongs to me. It was a treasury transfer.`

Luca should:
1. Correct the transaction
2. Record the wallet relationship
3. Update the ledger
4. Persist an applicable rule
5. Use the knowledge on future transactions
6. Maintain an audit record of the correction

User corrections outrank model guesses. This is central to Luca. The product becomes more valuable as it understands each operator.

## 16. Financial Memory vs Agent Memory

**Hermes memory** — suitable for: communication preferences, durable high-level user facts, broad operating preferences, high-level Luca context.

**Luca/Postgres memory** — suitable for: wallet ownership, wallet roles, counterparties, corrections, transaction classifications, thresholds, materiality, reporting settings, historical financial state.

Do NOT store a customer's entire financial history inside `MEMORY.md`.

## 17. Luca Core

Luca Core should be deterministic and usable independently of Hermes.

The exact directory names can follow the repo's existing structure instead of blindly introducing another duplicate folder. Audit what currently exists before moving files.

## 18. Blockchain Ingestion

V1 chain: Base. V1 assets: USDC + ETH.

Pipeline:
```
wallet registered → historical backfill → raw transactions →
normalize economic events → store → classify →
update ledger → run alert rules
```

Initial backfill: approximately 30 days. Then: incremental synchronization.

Do not fetch and reinterpret the entire wallet every time someone asks a question.

## 19. Data Source Hierarchy

Primary chain source: Alchemy / Base RPC.

Use it for: transactions, token transfers, logs, block information, balances, historical wallet activity.

PostgreSQL stores Luca's normalized financial history. Bankr is supplementary. Do not make Bankr the only source of financial truth.

## 20. Bankr

Bankr is useful infrastructure but Bankr is not Luca.

**Do not configure Bankr as Luca's Hermes LLM provider.** We already attempted that on the Mac — the Hermes version did not natively support Bankr as a model provider in the desired way and fell back to the supported OpenAI/Codex configuration.

Current direction:
- Hermes model = supported OpenAI / Codex path (ChatGPT Plus subscription)
- Bankr = financial / crypto tool (read-only)

## 21. Luca Core API

Hermes must NOT talk directly to PostgreSQL.

```
Hermes → Luca Finance tools → Luca Core API → PostgreSQL
```

Hermes explains. Luca Core calculates. This distinction is critical.

## 22. Core API Routes

```
GET  /health
GET  /wallets
POST /wallets
GET  /balances
GET  /activity
GET  /books/summary
GET  /books/events
GET  /unknowns
POST /corrections
GET  /reports
GET  /alerts
```

Eventually: `/counterparties`, `/treasury`, `/runway`, `/x402`.

Internal API initially binds to `127.0.0.1`. Do not expose it publicly without real authentication.

## 23. PostgreSQL

Core entities:
```
users, wallets, wallet_roles, transactions, normalized_events,
classifications, counterparty_rules, corrections, balance_snapshots,
alerts, briefs, watch_jobs, sync_runs, audit_log
```

Audit and improve the existing migration rather than replacing it unnecessarily.

## 24. Multi-User Architecture

Every financial row must be user-scoped with a stable `user_id`. Cross-user leakage is unacceptable. Hermes global/profile memory must never become the storage layer for different customers' financial information.

## 25. Worker

The Luca worker handles deterministic background work: wallet synchronization, new transaction discovery, normalization, deterministic classification, balance snapshots, alert evaluation, retry/reconciliation.

It should not require an LLM simply to detect that a new transaction occurred.

## 26. LLM Usage

**Good uses:** ambiguous transaction investigation, explanation, anomaly analysis, report narration, natural language interaction, understanding correction intent, comparing financial periods.

**Bad uses:** adding numbers, retrieving known ledger rows, checking if a transaction exists, polling wallets, basic classification rules, calculating revenue totals, determining owned-wallet transfers.

Financial arithmetic and accounting state should remain deterministic.

## 27. Monitoring

```
wallet worker → new financial event → deterministic classification →
ledger update → rules →
  is this meaningful?
    ├── no → silence
    └── yes → Hermes reasoning if needed → Telegram alert
```

Luca should be quiet by default.

## 28. Alert Philosophy

Silence is normal. Alert only when something matters.

Initial alert types: large inflow, large outflow, new significant counterparty, spending spike, treasury below threshold, round-trip movement, high unknown percentage, unusual gas, unusual x402 behavior.

Default materiality: ~$50, but must be configurable.

## 29. Daily Brief

```
Cash
$8,432 USDC
0.42 ETH

Yesterday

Revenue      +$620
Expenses     -$184
Gas          -$7.41
Net          +$428.59

Attention

• $240 payment to a new counterparty
• $93 remains unclassified
```

Do not generate long AI essays.

## 30. Telegram

Primary V1 interface: `@AskLucaBot`. Runs through Hermes' messaging gateway. Do not maintain a separate competing Telegraf bot once Hermes takes over the bot token.

## 31. Web Product

**Public marketing website:** explain Luca, show product, establish trust, explain security, show open-source direction, route people into Luca.

**Authenticated Luca web app navigation:** Home / Activity / Books / Wallets / Reports / Alerts / Luca / Settings.

The web app should not become a crypto trading dashboard. It should feel like: financial operations software + AI employee.

## 32. Web App Architecture

Web dashboard requests often do NOT require Hermes. Display transactions: Web → Luca API → Postgres — no LLM needed.

But "Why did expenses rise this month?" can become: Web → Hermes/Luca reasoning → Luca Core structured data → explanation.

Do not send every frontend request through an LLM.

## 33. Vercel

Use Vercel for: public website, web application, frontend, auth layer, product UI, future streamed web conversation.

Do not move Luca's entire financial backend to Vercel simply because the frontend is hosted there.

Production split:
```
VERCEL: marketing site, web app, frontend
VPS: Hermes, Luca API, Luca worker, PostgreSQL, monitoring
```

## 34. VPS

Production server: Ubuntu VPS.

Run: PostgreSQL, Luca API, Luca Worker, Hermes Luca profile, Hermes Gateway, backup process, logs/monitoring.

Do not require the Mac to remain online.

## 35. VPS Startup Dependency

```
Postgres → Luca API + Worker → Hermes Gateway → Telegram
```

Luca API must be healthy before relying on conversational financial queries.

## 36–38. Hermes & VPS Setup

- Use the current supported Hermes Linux installation process (official installer, not pip)
- Use Hermes' supported gateway/systemd mechanism for headless VPS
- Use Hermes profile export/import to migrate existing Mac Luca identity
- Use a dedicated `luca` Linux service user with a proper home directory (`/home/luca`)
- Keep application code at `/opt/luca` (not mixed into Hermes runtime state)

## 39. System Services

Production should have managed services for: `luca-api`, `luca-worker`, Hermes gateway, PostgreSQL. They must restart after process crash, SSH logout, and VPS reboot.

## 40. Critical Production Test

Luca is not deployed until this works:
1. Reboot VPS
2. Do NOT SSH back in
3. Open Telegram
4. Message `@AskLucaBot`
5. Ask Luca about the books
6. Receive a correct answer

## 41. Security Posture

**V1 is READ ONLY.** Luca cannot transfer funds, sign transactions, trade, swap, bridge, approve tokens, deploy contracts, or execute DeFi actions.

Never request or store seed phrases, private keys, or wallet passwords. Secrets remain server-side. Postgres not publicly exposed. Luca Core internal API remains localhost-only.

## 42. Product Interfaces (Long Term)

```
Human:    Telegram, Web App
Developer/Agent: API, MCP
```

All must operate against the SAME Luca Core. Do not create separate financial logic for each interface.

## 43. MCP

Not an immediate priority. Two directions:
- **Luca consumes MCP** — Hermes can use other MCP tools/services
- **Luca exposes MCP** — later, other agents call `get_cash_position`, `get_revenue`, `get_expenses`, etc.

Build this only after Luca's books are trustworthy.

## 44. Open-Source Direction

Luca should eventually be open source. Long-term someone should be able to clone Luca, configure database/Base provider/model/Telegram, and run Luca — with their own financial data, credentials, and wallet config staying in their own environment.

## 45. Luca Core vs Luca Cloud

- **Luca Core** — Open-source, self-hostable
- **Luca Cloud** — Managed commercial product (wins through convenience, uptime, collaboration, integrations, managed security, backups, operational simplicity)

Do not architect the open-source version as crippleware.

## 46. Build Phases

- **Phase 0** — Repository truth: audit implemented vs planned, run tests, compare code vs docs
- **Phase 1** — Stabilize Luca Core: schema, ingestion, normalization, classifications, corrections, books, API, worker, tests
- **Phase 2** — Fix production deployment: setup-vps.sh, user home, DB password, services, restart behavior
- **Phase 3** — Hermes migration: export Mac profile, import as `luca` on VPS, configure model/auth/Telegram
- **Phase 4** — Connect Hermes ↔ Luca Core: finance tools (balances, books, transactions, unknowns, corrections, wallet registration, reports)
- **Phase 5** — Telegram: move `@AskLucaBot` to Hermes Gateway, disable old Telegraf bot
- **Phase 6** — Monitoring: periodic wallet sync, incremental ingestion, classification, alert rules, daily/weekly brief
- **Phase 7** — VPS hardening: survive process restart, SSH logout, Hermes restart, VPS reboot, temporary provider failure
- **Phase 8** — Website: simple public landing page
- **Phase 9** — Web App: authentication, Home/Activity/Books/Wallets/Reports/Alerts/Luca chat/Settings on Vercel
- **Phase 10** — Private beta: ~5 operators, observe what Luca misunderstands
- **Phase 11** — Open-source readiness: README, LICENSE, CONTRIBUTING, architecture docs, Docker, self-host guide
- **Phase 12** — Platform expansion: MCP, public API, more chains, accounting exports, teams
- **Phase 13** — Controlled execution (much later, only after proven reliability + permissions + policy engine)

## 47. Things We Explicitly Should NOT Do Now

- Migrate everything to eve
- Build multiple agent runtimes
- Build MCP first
- Build multi-chain first
- Add trading or transaction signing
- Make Bankr the database or the LLM
- Let Hermes directly own the ledger
- Put customer transaction history in Markdown
- Build a giant dashboard before financial accuracy
- Rebuild working modules unnecessarily
- Add Redis without a real need
- Add microservices prematurely
- Create token-related product dependencies
- Reconnect Luca to Zetta

## 48. Luca and Zetta

Luca is standalone. No Zetta dependency. Do not write "Luca by Zetta" or "powered by Zetta" unless the founder explicitly changes direction.

## 49. Token

Luca must not depend on a token for identity, functionality, accounting, access, or product narrative. The product must make sense completely without a token.

## 50. Brand

- **Category:** Financial Agent
- **Positioning:** Private financial agent for on-chain operators
- **Hero:** Your financial employee on-chain
- **Tone:** Serious, calm, technical, precise, financially trustworthy
- **Visual:** Financial terminal × modern AI employee
- **Colors:** Black, off-white, charcoal, muted gray; green sparingly for healthy/confirmed states; red only for actual risk/action required
- **Typography:** Clean sans (Geist/Inter), monospace for financial/data values

Avoid: generic crypto dashboards, robot heads, meme aesthetics, excessive neon, trading UI, AI gradients everywhere.

## 51. The Core Strategic Sentence

- Hermes gives Luca agency.
- Luca Core gives Luca financial truth.
- The Luca repository owns the product.

**The moat:** operator-specific financial memory + corrected classification rules + wallet graph + counterparty graph + historical financial context + continuous monitoring + financial workflows + trust.

Models can change. Runtime frameworks can change. Blockchain providers can change. Luca's accumulated financial understanding should remain valuable.

## 52. Final Target

Immediate production target:
```
Dan
 │
 ▼
@AskLucaBot
 │
 ▼
Hermes — Luca Profile
 │
 ▼
Luca Finance Tools
 │
 ▼
Luca Core API
 │
 ├── Books
 ├── Classifications
 ├── Corrections
 ├── Reports
 └── Alerts
 │
 ▼
PostgreSQL
 │
 ├── Alchemy / Base
 └── Bankr read-only
```

Running continuously on the VPS.

Eventually:
```
                 LUCA CORE
                     │
      ┌──────────────┼──────────────┐
      │              │              │
   Telegram        Luca Web      API / MCP
      │              │              │
    Hermes        Vercel          Agents
```

Then: Open-source Luca Core + Managed Luca Cloud.

---

## 53. Build Log — What Has Been Shipped

### Infrastructure (VPS — 167.233.18.210, Ubuntu 24.04)

- PostgreSQL 16 running, database `luca`, app user `luca` with full schema grants
- Node 24, systemd services: `luca-api` (Fastify :3000, localhost-only), `luca-worker` (sync + classify + alerts + briefs)
- Hermes installed for `luca` user, profile at `/home/luca/.hermes/profiles/luca/`, systemd linger enabled (survives reboot)
- Hermes gateway auto-starts on boot via `hermes-gateway-luca.service` (user systemd)
- Hermes model: OpenAI Codex (ChatGPT Plus subscription, device auth)
- Telegram gateway: @AskLucaBot, allowed user 7021605011

### Luca Core API (`apps/api/index.ts`)

Endpoints live on `http://127.0.0.1:3000`. Auth: `x-user-id` header (localhost-only, V1 trust model).

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/health` | Liveness + DB check |
| GET | `/wallets` | List registered wallets with last sync time |
| POST | `/wallets` | Register wallet + create watch_job |
| GET | `/balances` | Latest balance snapshot per wallet/asset |
| GET | `/activity` | Paginated event feed with classification labels |
| GET | `/events` | Events filtered by label, for review |
| GET | `/unknowns` | Alias for `/events?label=unknown` |
| POST | `/corrections` | Submit classification correction |
| GET | `/books/summary` | P&L summary for a period |
| GET | `/books/events` | Line-item events by label |

### Luca Worker (`apps/worker/index.ts`)

- Polls every 60s, syncs all active wallets via Alchemy (Blockscout fallback)
- Snapshots ETH + USDC balances after each sync
- Classification engine: deterministic → counterparty rules → LLM (gpt-4o-mini, optional)
- Alert detectors: large inflow/outflow, new counterparty, spend spike, treasury floor
- Brief scheduler: daily/weekly (per user `brief_time` in DB)

### Hermes Plugin (`hermes/luca/plugins/luca_core.py`)

Tools available to Luca in Telegram:

| Tool | Description |
|------|-------------|
| `get_pnl_summary` | P&L breakdown for a period |
| `get_recent_events` | Transactions filtered by label |
| `get_wallet_balances` | Latest balance snapshots |
| `list_wallets` | Registered wallets |
| `register_wallet` | Add a new wallet to tracking |
| `get_activity` | Paginated activity feed with labels |
| `apply_correction` | Correct a transaction classification |
| `check_health` | API + DB liveness |

### Wallets Tracked (project wallets, owned by Dan)

| Label | Address | Chain |
|-------|---------|-------|
| treasury | `0xf1e958db7d1e4c074377946018ad645db4fb158e` | Base |
| deployer | `0x67976cebb5266b50a08c0dcb676e03baf305e3a2` | Base |

First sync: treasury 75 txns / $20,308 USDC, deployer 194 txns / 0.016 ETH. Both classified on first pass.

### Key Fixes Shipped

- `src/config.ts`: `OPENAI_API_KEY` removed from `requireProductionConfig()` — classification degrades gracefully
- `src/ingestion/ingest.ts:115`: incremental sync used 30-day backfill block range instead of `last_block+1` — fixed to `blockToHex(fromBlockNumber)`
- `migrations/001_initial_schema.sql`: added `GRANT ALL ON ALL TABLES/SEQUENCES` to avoid permission errors on fresh deploys

### Remaining Before Private Beta

- [ ] Label the 10 unknown counterparties flagged by the alert engine
- [ ] Landing page (Vercel, Phase 8)
- [ ] Invite 2–5 beta operators (Phase 9)
- [ ] Remove unused `@anthropic-ai/sdk` from package.json
- [ ] Delete `db/schema.sql` (diverged from migrations)
