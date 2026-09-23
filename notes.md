# Luca — Product & Architecture Notes

---

## The six moments that make Luca look insane

Not features. Moments that feel almost impossible.

### 1. Drop a wallet, Luca already understands the last 30 days
User sends `0x...` — Luca replies a minute later with books.
No dashboard setup. No spreadsheet import. Give Luca an address, get books back.

```
I found 147 transactions across this wallet.
Cash: $8,420 USDC
Revenue: $4,810 / Expenses: $1,940 / Gas: $83
Internal: $6,200 / Unknown: $410

Three things need your attention:
• $620 to a new counterparty
• spending is 1.8× your normal weekly rate
• 4 transactions still need context
```

That first interaction needs to be ridiculous.

### 2. Luca remembers corrections permanently
Probably the most important feature in the company.

User: *that $2,000 wasn't revenue, I moved it from my ops wallet. 0xABC is also mine.*
Luca reclassifies it and marks the wallet. Three months later — still knows.

That's when Luca stops feeling like AI and starts feeling like your employee.

### 3. Luca messages you before you ask
Wake up to:
```
Morning. Nothing major overnight.
One thing: Agent Wallet 3 spent $214 on APIs yesterday,
2.3× its 30-day average. Most came from one new counterparty.
Want me to break it down?
```
Or:
```
Treasury dropped below your $5,000 floor 18 minutes ago.
Current: $4,612 USDC
Largest movement: $1,400 → 0x71A… (unknown)
I'd review this one.
```
Luca working while you sleep.

### 4. Ask financial questions like you'd ask a human
No commands. Natural language.

*"why did we spend so much this week?"*
→ Luca breaks down the spike by category and identifies the source.

*"can we afford another $1k/month server?"*
→ At current 30-day burn you have ~7.4 months runway. Adding $1k/month reduces that to ~6.1 months assuming revenue stays flat.

Financial judgment, not wallet lookup.

### 5. One Luca across every chat
Same user. Same books. Same memory. Channels feel like phone numbers for the same employee.
```
Telegram ─┐
iMessage ──┼── Luca → same memory, same books, same context
```
"What happened with that weird payment yesterday?" works from any channel.

### 6. The entity graph
The thing that eventually makes Luca genuinely hard to replace.

```
Dan
├── Personal (Wallet A, Wallet B)
├── Luca (Operations, Treasury, Agent Wallet 1)
└── Somehow (Revenue wallet, Expenses wallet)

Counterparties:
  OpenAI        → inference
  Alchemy       → infrastructure
  0x842…        → contractor
  0x934…        → customer
  0x173…        → owned treasury
```

Luca sees your financial world, not just blockchain activity.
Foundation for P&L, budgets, runway, agent profitability, treasury management, taxes, controls.

---

## The demo sequence to target

```
You:   watch this wallet
Luca:  Done. 183 transactions, last 30 days. Books started. 6 I don't understand yet.

You:   0xABC is mine. It's treasury.
Luca:  Got it. Reclassified 4 transfers ($7,300) as internal treasury movements.
       Reported expenses dropped from $4,910 to $2,110.

[next morning, unprompted]
Luca:  Morning. Books up to date.
       Revenue yesterday: $820 / Expenses: $214 / Net: +$606
       One thing needs attention: $430 to a counterparty I haven't seen before.

You:   what was it?
Luca:  Ops wallet, 02:14 UTC. Can't identify recipient confidently.
       No similar transactions in your history.
```

That is the product. Not a dashboard. Not "AI-powered accounting." Not 40 features.
An employee that knows the books.

Get these six right. Everything else — iMessage, MCP, more chains, teams, tax exports,
agent budgets, controlled spending — is expansion around something already deeply valuable.

---

---

## Architecture direction (migration away from Hermes)

**Core principle**: Luca owns its own agent. No external agent framework.

**The agent loop is tiny**:
```
receive message
→ load Luca policy (repo)
→ load user/session context
→ give model Luca's approved financial tools
→ model calls tool
→ execute against Luca Core
→ repeat if needed (maxSteps = 6)
→ answer
```

**Four types of context — nothing else**:
1. Product truth — version-controlled in repo (LUCA.md, system-prompt.ts, accounting-policy.md)
2. Financial memory — Postgres (wallet labels, counterparty rules, corrections)
3. Conversation context — recent session history only
4. ~~General long-term agent memory~~ — explicitly no. If Luca "remembers" something, we must be able to say which table it's in and why.

**Tool surface — financial only**:
```
get_cash_position, get_books_summary, get_recent_activity,
get_wallets, get_wallet_balance, get_unknown_transactions,
get_transaction, apply_correction, get_financial_brief, get_alerts
```
No shell access. No filesystem. No browser. No plugin ecosystem.

**Folder structure**:
```
src/agent/
  system.ts
  run.ts
  tools.ts
  context.ts
  guardrails.ts
```

**Library**: Vercel AI SDK Core (thin infrastructure, not a framework). Not eve, not Hermes, not another big runtime. Model stays replaceable.

**Worker stays dumb**: ingestion → classification → alert rules all deterministic. Model only invoked when reasoning or communication is genuinely needed. No idle model cost.

**Migration order**: build src/agent/ → test in terminal → connect Telegram → remove Hermes. Rollback path stays clean throughout.

**Open source story after migration**:
```
git clone github.com/danbuildss/luca
cp .env.example .env && npm install && npm run db:migrate && npm run luca
```
No "install Hermes, copy skill files, import a profile."

---

## Product roadmap

**Luca's job (freeze this)**:
> Watch the wallets that run an on-chain operation, keep the books, remember what the money means, and surface what deserves attention.

**Loop**: Watch → Classify → Remember → Understand → Brief → Alert

**What Luca is NOT**:
- Trading / swaps / sending money
- Generic research
- Coding assistant
- Personal assistant
- "Do anything" agent

When asked outside its domain, Luca says: *"That isn't my job."*

**Success check (Phase 0)**: Someone asks "What does Luca do?" — one sentence answer, no mention of frameworks, models, or blockchain plumbing.

---

### Phase roadmap

| Phase | What | Success signal |
|-------|------|---------------|
| 0 | Lock the product definition | One sentence answer to "what does Luca do?" |
| 1 | Build src/agent/ (Hermes replacement) | Terminal conversation works without Hermes |
| 2 | Financial memory as the real product | Correction made once, still applied one month later |
| 3 | Telegram as first real home | Operate Luca almost entirely by chatting |
| 4 | Outer loop (proactive, worker-driven) | Luca messages you — you didn't message it first |
| 5 | Accuracy & trust | Books trusted without manual checking every result |
| 6 | Perfect the brief | Understand financial position without opening a dashboard |
| 7 | First 5 real operators | At least some users would be annoyed if Luca disappeared |
| 8 | iMessage (second channel) | Channel switch doesn't change memory or financial understanding |
| 9 | Other channels (Slack, Signal, etc.) | Add a surface without touching the accounting engine |
| 10 | Entity understanding | Books by entity: project P&L, personal vs business, agent P&L, runway |
| 11 | Agent businesses | Which agents are profitable? What's overnight agent spend? |
| 12 | Financial system of record | Other software asks Luca for financial truth (API/MCP) |
| 13 | Controlled action | Observe → Recommend → Prepare → Execute (slowly, carefully) |

---

### The brief (Phase 6 target format)
```
Morning. Here's what changed.

Cash: $12,481 USDC

Yesterday
  Revenue  +$1,420
  Expenses   -$386
  Gas          -$12
  Net       +$1,022

Attention
  • $750 sent to a new counterparty
  • treasury is down 14% this week
  • $83 still needs classification
```

Brief is channel-independent. Arrives wherever the operator is.

---

### Channel architecture (Phase 8+)
```
TelegramAdapter     →  Luca Agent  →  Luca Core
iMessageAdapter
```

One ChannelAdapter interface: `receive()`, `send()`, `identifyUser()`, `formatMessage()`.
Same brain. Same books. Same memory. Same financial truth across channels.

---

### Long-term trajectory
```
NOW       Private on-chain bookkeeper
NEXT      Financial memory
THEN      Always-on financial employee
THEN      Books for an entire operation
THEN      Finance OS for agent businesses
EVENTUALLY  Financial control plane
```

**Constraint to protect throughout**: One agent. One domain. One job.

> Luca's superpower: when someone asks "What's happening with my money?" — Luca knows the answer better than anything else they use.

---

## Build log — active development

### Principles (locked)

- One agent. One domain. One job. Trust + reliability mode.
- V1 is READ ONLY — Luca must never send funds, sign transactions, swap, approve contracts, trade, bridge, deploy contracts, request private keys or seed phrases.
- No secrets committed to git. API secrets server-side only.
- Hermes memory must not be used as Luca's accounting database.
- Every financial tool invocation scoped to the authenticated user. Cross-user leakage must be architecturally impossible.
- The database is financial truth. LLM reasons over truth, never replaces it.

### VPS

- Host: root@167.233.18.210, Ubuntu 24.04, `/opt/luca`
- Services: `luca-worker`, `luca-telegram`, `luca-api` (systemd)
- DB: Supabase Postgres
- Tracked wallets: treasury (`0xf1e958...`) + deployer (`0x67976c...`) on Base, Aeon founder wallets
- `materiality_usd = $50` (alert threshold)
- Brief fires at 08:00 UTC daily, weekly on Mondays

### Phase 1 — Verify services (complete)

Confirmed worker loop, watch jobs, Telegram bot, and brief scheduler all survive reboots. Fixed stuck watch_jobs.

### Phase 2 — Review/label unknown transactions (complete)

Built `/review` command. Counterparty alert flow: `detectUnknownCounterparties` → `pending_counterparty_alerts` → Telegram inline keyboard → `applyCorrection` → `counterparty_rules`.

**Key bug fixed**: Telegram callback_data limit is 64 bytes. Old format `alert_label:uuid:uuid:label` = 93+ chars → `BUTTON_DATA_INVALID`. Fixed to `al:uuid:label` = 47 chars in `src/telegram/alerts.ts:buildAlertKeyboard`. Server-side resolves `eventId` from `alertId`.

### Phase 3 — Classification quality harness (complete, PR #30 merged)

New files:
- `src/quality/metrics.ts` — SQL functions: `getHealthSnapshot`, `getMethodErrorRates`, `getCalibrationBuckets`, `getCounterpartyCorrections`, `getLabelPrecision`, `getUnknownDecomposition`, `getHighConfidenceErrorRate`
- `src/quality/report.ts` — formats 7-day quality report (6 sections: health snapshot → label precision → method error rates → calibration gaps → unknown decomposition → to-do list)
- `src/telegram/commands/quality.ts` — `/quality` Telegram command
- Added `detectClassifierDegradation` to `src/alerts/detectors.ts` — fires when high-conf error rate >5% with ≥10 samples
- Wired into `src/alerts/engine.ts`
- Added `/quality` to bot + `/start` menu

All 11 stuck counterparty alerts delivered after Phase 3 deploy (restart cleared the old BUTTON_DATA_INVALID backlog).

### Phase 4 — Gate C proactive alerts (verified, no new code)

Verified all detectors live and healthy:
- `large_inflow` / `large_outflow`: 12 alerts fired Sept 21
- `spend_spike`, `treasury_floor`, `unusual_gas`: wired, no fires (conditions not met)
- `classifier_degradation`: wired
- Brief scheduler: running, first automated brief fires at 08:00 UTC
- Counterparty alerts: 11 delivered after Phase 3 deploy

### Phase 5 — Reliability (complete, PR #31 merged)

New files:
- `migrations/004_worker_heartbeat.sql` — single-row `worker_heartbeat` table
- `src/health/monitor.ts` — `pingWorkerHeartbeat`, `getWorkerHeartbeat`, `getStaleWallets`, `getDiskUsage`
- `src/health/detectors.ts` — `detectWorkerStale` (fires if heartbeat >5min stale), `detectStaleWallets` (>4h), `detectDiskPressure` (80%/90%)
- `scripts/backup.sh` — pg_dump → gzip → `/opt/luca/backups/`, 7-day retention
- `deploy/luca-backup.{service,timer}` — systemd daily backup at 02:00 UTC

Changes:
- Worker pings heartbeat at top of every `runCycle()`
- Worker runs `detectStaleWallets` + `detectDiskPressure` per user each cycle
- Telegram bot runs `detectWorkerStale` every 5min independently (so if worker dies, bot still raises the alarm)
- All health alerts land in `alerts` table, delivered by normal pipeline

VPS deploy: migration applied, `luca-telegram` restarted. Backup timer enabled.

### Phase 6 — Daily use evaluation (next)

---

## Final phase sequence (locked 2026-09-23)

Incorporates Bankr's feedback. This is the sequence we follow.

**Constraint to protect throughout:**
> trustworthy books → financial heartbeat → proactive jobs → daily brief → memory → real operators → more channels

No WhatsApp, iMessage, MCP, Solana, dashboards, or execution until classification is trusted. Sequence is the product strategy.

---

### Phase 3 — Classification Quality *(current)*

Exit criteria: "Luca's books are becoming more accurate as I correct it."

**Gate:** Do not start Phase 4 until at least one week of real correction data is flowing and baselines are readable.

Build order:
1. Audit corrections table schema — verify all fields captured: `classification_id`, `old_label`, `new_label`, `old_confidence`, `correction_timestamp`, `user_context`, `counterparty`, `created_rule`
2. Rewrite `/quality` metrics as a SQL view — parameterizable by date, label, method, counterparty (not application code)
3. High-confidence error query — run against real wallet history, read what it surfaces
4. Calibration bucket view — verify confidence scores are honest
5. Root cause tagging on corrections — bad rule / missing counterparty / bad model inference / missing protocol / bad data
6. Gold set — 100 transactions in own DB table, stratified across 9 labels and 4 methods, run on every deploy
7. Trend tracking — correction rate and unknown rate week over week, not just snapshots

**Built so far:** `/quality` command, metrics queries, `detectClassifierDegradation` alert. Error rate by label/method, high-conf errors, calibration, unknown decomposition all queryable. Root cause tagging, gold set, trend tracking, and SQL view still to build.

---

### Phase 4 — Financial Heartbeat

Health of Luca's financial *understanding*, not process liveness.

- `heartbeat_baselines` table — stored explicitly, not computed dynamically
- Track: classified %, unknown %, low-confidence %, high-confidence corrections, data freshness, provider status, blocks processed, last successful brief, Telegram delivery, model failures
- Anomaly detection: unknown rate spikes from baseline → alert
- Distinguish data freshness degradation (RPC/blocks) from classification quality degradation (unknown rate spike) — different causes, different fixes

---

### Phase 5 — Financial Jobs

Luca as a set of recurring jobs. Each job has purpose, trigger, inputs, rules, output, quality metric — stored in Postgres with `last_run`, `last_success`, `last_output_summary`, `quality_score`.

Start with: `transaction-classifier`, `unknown-review`, `counterparty-watch`, `daily-brief`, `treasury-watch`, `spend-velocity`, `large-movement-watch`, `reclassification-watch`

`reclassification-watch`: when a new counterparty rule is created from a correction, find all prior transactions from that counterparty and flag for review. Propose, never auto-apply.

Later: `cash-runway`, `weekly-close`, `monthly-close`, `round-trip-detector`

---

### Phase 6 — Proactive Monitoring

Worker loop: `ingest → classify → update books → evaluate jobs → stay silent unless something matters`

Luca messages you unprompted. Treasury floor hit. Spend spike. First payment to new counterparty. Transactions needing context. This is when Luca stops feeling like a chatbot.

---

### Phase 7 — Daily Brief (perfected)

Numbers from deterministic books. No AI essay. Short. Ships only after books are trusted.

---

### Phase 8 — Financial Memory

Wallet roles as first-class DB entities (`added_by`, `added_at`, `confidence`, `source`). Counterparty correction history is the moat. Every correction permanently improves future classifications. The corrected financial graph, not the LLM.

---

### Phase 9 — Safe Self-Healing

Retry RPC, ingestion, fallback data source, re-index missing ranges, rerun failed jobs, retry message delivery. Never silently rewrite accounting logic. Proposals show evidence + expected impact (how many past transactions affected).

---

### Phase 10 — Proof of Work

Luca reports its own work: classified 147 transactions, $8,412 actual revenue vs $13,902 gross inflow, 3 unclassified, treasury below floor. Autonomy is credible when work leaves observable evidence.

---

### Phase 11 — Real Operators (3–5)

Messy real wallets. Watch what Luca misunderstands, corrects, what annoys, what saves time, what they still use spreadsheets for. Those users become the next product spec.

---

### Phase 12 — Second Channel

WhatsApp first, then iMessage. One adapter into the same Luca. Same books, same memory, same brain. Never build separate Lucas.
