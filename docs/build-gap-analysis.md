# Luca V1 — Current-State and Build-Gap Analysis

> **Historical document.** This analysis predates the current architecture and product direction. References to Hermes, registries or earlier positioning are superseded — see [README.md](../README.md) and [architecture.md](architecture.md) for how Luca works today.

## Executive summary

The repository is a strong **product and agent-behaviour specification**, but it is
not yet a runnable financial system. It defines Luca's identity, accounting rules,
Telegram interaction, alert philosophy, prompts, target architecture, environment
variables, and an initial PostgreSQL schema. It does not contain Luca Core, a chain
indexer, a classifier, ledger queries, a Telegram application, an API, a migration
runner, cron scripts, or tests.

That means the central product claim—"Luca's own ledger is the source of truth"—is
currently an architectural intention rather than an implemented invariant. Hermes
has detailed instructions for how Luca should behave, but no deterministic tools to
read or update that ledger.

The correct next step is not a dashboard or transaction execution. It is a thin,
end-to-end, read-only vertical slice:

```text
register one Base wallet
  -> backfill USDC and ETH activity
  -> normalize and persist it idempotently
  -> classify deterministic cases
  -> expose unknowns and accept corrections
  -> calculate reproducible books
  -> produce one Telegram brief from stored data
  -> resume correctly after restart
```

## What exists today

| Area | Current artifact | Assessment |
| --- | --- | --- |
| Product definition | `LUCA.md`, `README.md` | Clear wedge, scope, non-goals, accounting principles, and go-live criteria. |
| Agent identity | `hermes/SOUL.md`, `hermes/luca/IDENTITY.md` | Strong, conservative voice and explicit read-only posture. |
| Operating rules | `hermes/luca/AGENTS.md`, `RULES.md`, `OPERATIONS.md`, `SECURITY.md` | Good behavioural specification, but instructions cannot enforce data integrity by themselves. |
| Telegram UX | `TELEGRAM.md`, `COMMANDS.md` | Detailed response contracts and command concepts; no bot handlers exist. |
| Monitoring | `HEARTBEAT.md`, `ALERTS.md`, `hermes/cron/daily-brief.md` | Alert and brief policies exist as Markdown; there are no executable sync or alert jobs. |
| LLM prompts | `prompts/*.md` | Useful templates for classification, investigation, and reporting; there is no renderer, schema validation, or model adapter. |
| Hermes profile | `hermes/config.yaml`, `BOOTSTRAP.md`, `.env.example` | A profile-shaped configuration exists, but it has not been proven against a runnable install in this repository. |
| Database | `db/schema.sql` | Useful first relational model; it is a single bootstrap SQL file rather than versioned migrations. |
| Node project | `package.json` | Dependencies and intended scripts are declared. Their referenced source files and tool configuration do not exist. |
| Application code | none | `apps/`, `core/`, and `scripts/` shown in the README are absent. |
| Verification | none | No automated tests, fixtures, lint config, TypeScript config, CI, or reconciliation suite exists. |

## What is already well aligned with the proposed product

1. **The product wedge is correct.** The documents consistently prioritize
   persistent financial understanding over trading or a generic crypto assistant.
2. **Execution is explicitly off.** Identity, skill, and security files all prohibit
   signing, transfers, swaps, and approvals.
3. **The evidence hierarchy is conservative.** Deterministic evidence and user
   corrections precede model inference, and `unknown` is treated as valid.
4. **The intended data model is user-scoped.** Most financial tables carry a
   `user_id`, which is the right basis for future hosted isolation.
5. **The user experience is concrete.** Brief, alert, and correction interactions
   are described well enough to turn into acceptance tests.
6. **Base, USDC, and ETH are a sensible V1 boundary.** The current materials mostly
   maintain this narrow scope.

## Critical gaps and contradictions

### 1. The documented quick start is not executable

`package.json` refers to TypeScript entry points under `apps/` and scripts under
`scripts/`; neither directory exists. There is no `tsconfig.json`, ESLint
configuration, migration runner, or compiled output. `npm run dev`, `npm run build`,
`npm run db:migrate`, `npm run backfill`, and the production command therefore cannot
successfully provide the documented system.

**Decision:** call the repository specification-first until the first vertical
slice exists. Do not describe the missing services as current capabilities.

### 2. Luca's ledger does not yet exist as an operational source of truth

The SQL schema defines storage, but no code writes normalized events, enforces
classification precedence, computes books, or reads reports. The Markdown files
currently invite Hermes to update `MEMORY.md` and `BOOKS.md`, which conflicts with
the desired boundary:

```text
Postgres = financial truth and user-specific memory
Hermes memory = small product/operator context only
```

**Decision:** once Luca Core exists, transaction corrections, counterparties,
wallet ownership, rules, sync checkpoints, reports, and alert state must be database
records. Hermes must use typed tools rather than editing financial Markdown.

### 3. The runtime story is inconsistent

The current setup guide describes deleting parts of a default local Hermes install
and copying files into `~/.hermes`. The desired architecture requires an isolated
`luca` profile on a VPS. Other documents alternate between Mac development, PM2
services, a generic Hermes daemon, and a future VPS phase.

**Decision:** make the dedicated Hermes `luca` profile canonical now. Separate:

- local Luca Core development;
- a persistent Hermes gateway profile;
- deterministic worker/scheduler processes;
- PostgreSQL;
- deployment and backup procedures.

Do not require destructive deletion of a user's existing Hermes state.

### 4. Bankr's boundary is ambiguous

Some files call Bankr the LLM/reasoning layer; others call it blockchain and
financial data access. The intended design says Bankr is an external read-only
financial tool while Luca's deterministic Base ingestion and database remain the
authority.

**Decision:** define explicit adapters and trust boundaries:

| Adapter | Responsibility | May write Luca truth? |
| --- | --- | --- |
| Base provider/indexer | blocks, receipts, logs, token transfers | raw observations only |
| Price provider/Bankr | prices, portfolio context, research | cached evidence only |
| Model provider | explanation and low-confidence fallback | proposed classification only |
| Luca Core | normalization, rules, corrections, books | yes |

Use a dedicated Bankr key configured read-only and restricted to the production VPS
where supported. Luca must remain safe even if prompt instructions fail: no signing
credentials or write-capable financial tools should be present.

### 5. Classification vocabulary is inconsistent

The proposed nine labels are singular and explicit:

```text
revenue, expense, internal_transfer, treasury, gas,
x402_income, x402_spend, refund, unknown
```

The repository also uses `expenses`, `internal`, and sometimes omits `refund`.
`refund` additionally needs direction-aware accounting: a refund received reverses
an expense, while a refund issued reverses revenue. Unifying these names before code
and data accumulate avoids report drift and difficult migrations.

**Decision:** define one versioned enum in Luca Core and a database constraint. Keep
display labels separate from stored values.

### 6. The initial schema needs hardening

The schema is a useful sketch, not yet production-safe:

- PostgreSQL UUID generation depends on an extension that is not enabled in the SQL.
- Core foreign keys and timestamps are often nullable.
- Addresses are not normalized or case-insensitively constrained.
- Classifications can have multiple unconstrained active rows per event.
- Confidence has no `0..1` constraint and labels/methods are free text.
- Normalized events lack a stable event/log identity, so one transaction containing
  multiple token transfers cannot be safely deduplicated by hash alone.
- Native value, token contract, decimals, log index, transaction index, receipt
  status, and finality/reorg state are not modeled.
- A transaction is tied to a watched wallet, duplicating chain facts when multiple
  watched wallets participate.
- Price source, price timestamp, and valuation provenance are absent.
- Corrections do not encode whether they created a reusable rule or who made the
  change in a durable audit trail.
- There is no general audit-log table, balance-snapshot table, report delivery
  idempotency key, alert deduplication key, or database-level tenant protection.
- `watch_jobs` has no uniqueness rule, and `normalized_events` has no deduplication
  constraint.

**Decision:** replace the bootstrap file with ordered migrations before relying on
real financial history. Preserve raw provider payloads, but make normalized event
identity and reprocessing deterministic.

### 7. ETH accounting needs an explicit event model

One chain transaction can contain native ETH value, several ERC-20 transfers, an
internal transfer, and gas. Treating a transaction as one financial row will lose or
double-count activity. Gas is attributable to the sender and should be a separate
ledger event. Contract calls that move no value should not become financial events.

**Decision:** model immutable chain transactions and receipts separately from
wallet-relative financial events. Generate one canonical event per economic movement
plus a gas event, each with a stable source identity.

### 8. USD reporting has no defined valuation policy

USDC can normally be treated near one dollar, but historical ETH reporting requires
a reproducible price source and timestamp policy. Using the current price for old
transactions makes old reports change when regenerated.

**Decision:** persist the source, quote currency, observed-at timestamp, and price
used for every valuation. Reports must use stored historical valuation inputs or an
explicitly versioned restatement policy.

### 9. Monitoring is prose rather than an idempotent state machine

Heartbeat and cron files describe behaviour but not concurrency, retries, block
finality, reorg handling, stale data, pagination, partial provider failure, or alert
deduplication. Updating a timestamp in `MEMORY.md` is not a safe checkpoint.

**Decision:** make syncing a leased, retryable database job. Advance a cursor only
after the corresponding batch commits. Record provider range, block range, result,
duration, and error. Separate frequent deterministic sync/alert evaluation from
scheduled LLM-assisted summaries.

### 10. Multi-user isolation is conceptual, not enforced

User IDs appear in the schema, but there is no authenticated request context, query
layer, row-level security, tool authorization, or test proving that cross-user reads
are impossible. A Telegram allowlist is enough for the single-user alpha only.

**Decision:** implement a single-principal alpha first while retaining `user_id` in
every owned record. Before beta, add PostgreSQL row-level security or an equivalently
strong repository boundary, authenticated Telegram-to-user mapping, negative tenant
tests, and per-user job/report scoping.

## Recommended target architecture

```text
Telegram
   |
Hermes Luca profile ---------------------- Bankr (read-only context)
   | typed Luca tools
   v
Luca API / tool boundary
   |
   +-- wallet registry
   +-- books and queries
   +-- corrections and rules
   +-- reports and alerts
   |
PostgreSQL <---- deterministic worker <---- Base RPC/indexer
   ^                    |
   |                    +-- normalize
   |                    +-- classify rules
   |                    +-- reconcile/checkpoint
   |
scheduler -------- sync / alert / brief jobs
```

### Ownership rules

- **Hermes owns:** conversation, intent routing, concise explanation, delivery.
- **Luca Core owns:** schemas, invariants, classification precedence, ledger math,
  tenant scope, corrections, and auditability.
- **Worker owns:** ingestion, canonicalization, retries, reconciliation, and cursors.
- **PostgreSQL owns:** durable financial truth.
- **Bankr owns:** optional read-only market/portfolio context, never the ledger.
- **Telegram owns:** transport only; Telegram messages are not financial storage.

## Build plan

### Phase 0 — Make the contract executable

Deliverables:

1. Add TypeScript configuration, formatting/lint rules, a lockfile, CI, and a test
   runner.
2. Validate environment variables at startup and fail closed.
3. Introduce versioned migrations and a disposable test database.
4. Define shared types for chain, asset, wallet role, classification, confidence,
   evidence, and money values.
5. Add fixture-based tests for USDC transfer, ETH transfer, contract call, failed
   transaction, internal transfer, and gas.

Exit criteria: a clean checkout can install, migrate, typecheck, test, build, and
start a health endpoint using documented commands.

### Phase 1 — One-wallet ledger vertical slice

Deliverables:

1. Create a single alpha user and register one checksummed Base wallet.
2. Backfill 30 days using one provider adapter with pagination and rate-limit retry.
3. Store immutable raw observations and canonical transaction/receipt/log identities.
4. Normalize Base ETH and canonical USDC movements only.
5. Store gas as its own event and ignore unsupported assets without losing raw data.
6. Make every write idempotent and safe to replay.
7. Provide CLI queries for balance/activity/unknowns.

Exit criteria: repeated backfills produce identical row counts and totals; supported
provider activity reconciles against an independently fetched fixture or explorer
sample.

### Phase 2 — Deterministic classification and corrections

Deliverables:

1. Implement classification precedence as code: explicit transaction override,
   learned exact rule, ownership/internal rule, protocol rule, deterministic gas,
   model proposal, unknown.
2. Persist evidence as structured records, not only prose.
3. Add counterparties and reusable rules with explicit scope (address, direction,
   asset, optional amount/cadence).
4. Implement correction transactions with before/after audit entries.
5. Reclassify affected future or selected historical events deterministically.

Exit criteria: the same ledger plus the same rule version always yields the same
classification; corrections survive restart and apply only within their scope.

### Phase 3 — Books and reproducible reports

Deliverables:

1. Implement period queries for revenue, expense, x402 activity, refund adjustments,
   gas, internal transfers, treasury movements, and unknowns.
2. Define net operating flow separately from total wallet balance change.
3. Store valuation provenance and report cut-off times.
4. Add daily/weekly/monthly report snapshots linked to source event and rule versions.
5. Add reconciliation checks: opening balance + supported flows = closing balance,
   with explicit unsupported/reorg adjustments.

Exit criteria: identical inputs reproduce identical reports, and every total can be
drilled down to event IDs and transaction hashes.

### Phase 4 — Hermes and Telegram integration

Deliverables:

1. Create a dedicated `luca` profile without modifying the default Hermes profile.
2. Expose narrow typed tools such as `add_wallet`, `get_books`, `get_unknowns`,
   `correct_classification`, `label_counterparty`, and `get_sync_status`.
3. Require an explicit `user_id` in the internal tool context; do not accept it from
   free-form model arguments.
4. Implement `/start`, `/wallets`, `/brief`, `/unknowns`, and natural-language query
   routing against stored books.
5. Allow only the configured Telegram principal during alpha.
6. Treat all chain metadata and tool output as untrusted content.

Exit criteria: Luca answers from the database, never recalculates books in a prompt,
and a correction made in Telegram changes the next deterministic query.

### Phase 5 — Continuous monitoring and alerts

Deliverables:

1. Run incremental sync from database checkpoints at a conservative cadence.
2. Add confirmation depth and reorg recovery.
3. Evaluate alert rules without an LLM.
4. Add deduplication, cooldowns, acknowledgements, and delivery-attempt records.
5. Escalate only ambiguous investigation or wording to Hermes.
6. Generate briefs from a frozen report payload; let the model summarize but not
   change numbers.

Exit criteria: restarts, duplicate jobs, provider timeouts, and Telegram retries do
not duplicate events, alerts, or briefs.

### Phase 6 — Production hardening and private alpha

Deliverables:

1. Deploy under a dedicated Linux user with least privilege and system services.
2. Use read-only/IP-restricted external credentials, no wallet signing material, and
   outbound network restrictions where practical.
3. Add structured logs with secret/address redaction, metrics, health/readiness
   checks, stale-sync alerts, and log rotation.
4. Add encrypted daily backups and perform a restore drill.
5. Add provider failover or a documented degraded mode.
6. Run Luca on the operator's real wallets daily and record misclassifications.

Exit criteria: the full V1 loop survives a service and VPS restart, backups restore,
and stale or incomplete data is visibly marked rather than reported as current.

### Phase 7 — Private beta only after alpha quality

Deliverables:

1. Enforce tenant isolation in database and application layers.
2. Test cross-user access attempts for every tool and job.
3. Add onboarding, wallet ownership declarations, deletion/export, retention, and
   incident procedures.
4. Define service limits and cost controls.

Exit criteria: zero known cross-user paths, operational recovery is documented, and
classification quality meets an agreed measured threshold.

Open-source packaging, Luca Cloud, more chains, a dashboard, and any execution path
come after this phase—not before it.

## Minimum V1 acceptance suite

The following scenarios should be automated before calling V1 shipped:

1. A 30-day backfill paginates without gaps.
2. Replaying the same range creates no duplicates.
3. Two watched wallets in one transfer produce correct wallet-relative views without
   double-counting consolidated books.
4. An ERC-20 transaction with multiple logs creates the correct number of events.
5. A failed transaction records gas but not a successful value movement.
6. A reorg removes or supersedes affected observations and reports.
7. USDC decimals and ETH wei conversions are exact; no JavaScript floating-point
   values are used for money.
8. Internal transfers never enter revenue or expense.
9. Inbound unknowns never become revenue solely because of direction.
10. A correction survives restart and scopes correctly to later transactions.
11. Historical ETH valuation is reproducible.
12. Report totals drill down to their constituent events.
13. A provider failure does not advance the sync cursor.
14. A repeated alert evaluation sends only one alert within its deduplication window.
15. Telegram retries do not send duplicate briefs.
16. Stale data is labeled and never presented as fresh.
17. Secrets and full sensitive identifiers are absent from logs.
18. A backup restores users, wallets, rules, events, corrections, and checkpoints.
19. Every tool rejects missing or mismatched user context.
20. The system contains no signing key and cannot invoke a write endpoint.

## Decisions to lock before implementation

These are product/engineering choices, not reasons to delay the first vertical
slice. Record each as an architecture decision:

1. **Base data provider:** managed indexer, direct RPC/log scanning, or a hybrid.
2. **Finality policy:** confirmation depth and how provisional activity is displayed.
3. **Canonical USDC contracts:** supported contract addresses and treatment of
   bridged variants.
4. **Price policy:** source, sampling timestamp, stablecoin depeg handling, and
   restatement rules.
5. **Treasury semantics:** whether `treasury` classifies a movement, wallet role, or
   both. Wallet role alone should not turn every receipt into treasury income.
6. **Refund semantics:** reversal linkage and reporting for received versus issued
   refunds.
7. **Rule precedence:** exact ordering, rule versions, and historical reprocessing.
8. **Model boundary:** provider, structured output contract, timeout, and behaviour
   when unavailable.
9. **Alpha deployment:** whether Luca Core jobs run as separate systemd services or
   as explicitly supported Hermes no-agent jobs.
10. **Data privacy:** retention, deletion, export, encryption, and which addresses
    may appear in Telegram.

## Recommended immediate milestone

Build only this milestone next:

> Given one declared Base wallet and a date range, Luca Core imports USDC/ETH
> activity into PostgreSQL exactly once, classifies gas and internal transfers,
> leaves everything else honestly unknown, accepts a durable correction, and prints
> a reproducible report with transaction-level evidence.

This milestone proves the differentiating asset—the corrected financial ledger—before
adding more agent behaviour. Once it works, Hermes and Telegram become thin, useful
interfaces over a trustworthy system rather than substitutes for one.

## Approval-gated execution plan

No implementation phase starts automatically. Before each phase, provide the
operator with a short proposal containing:

1. the exact outcome;
2. files and infrastructure expected to change;
3. external services and credentials required;
4. important design choices and trade-offs;
5. acceptance tests and a rollback plan; and
6. an explicit approval question.

Only documentation and investigation needed to prepare that proposal may happen
before approval. Do not provision infrastructure, connect a production wallet, use
paid APIs, modify the database, or implement the phase until the operator approves
its scope. Approval for one phase does not imply approval for a later phase. If the
approved scope needs to materially change, stop and request approval again.

### Proposed approval sequence

| Gate | Proposal | What the operator will be able to verify |
| --- | --- | --- |
| A | Project foundation | A clean checkout installs, typechecks, tests, builds, migrates a disposable PostgreSQL database, and exposes a local health check. |
| B | Base ingestion | One declared test wallet can be backfilled for USDC and ETH without gaps or duplicates; no Telegram, Bankr, or production wallet is required. |
| C | Classification and corrections | Deterministic gas/internal rules work, unresolved events remain unknown, and approved corrections persist and replay predictably. |
| D | Books and reports | Period totals are reproducible, valuations record provenance, and every number drills down to chain evidence. |
| E | Hermes and Telegram | A dedicated Luca profile invokes typed read-only tools and only the approved Telegram account can access the alpha. |
| F | Monitoring and alerts | Incremental sync, restart recovery, alert deduplication, and scheduled briefs work without continuous LLM calls. |
| G | VPS private alpha | The approved services are deployed with backups, recovery checks, monitoring, and read-only restricted credentials. |
| H | Private beta | Tenant isolation and cross-user tests pass before adding any other operator. |

Execution, signing, swaps, transfers, additional chains, a dashboard, public access,
Luca Cloud, and token-related work are excluded from every gate above. Each would
require its own future proposal and explicit approval.

### Gate A proposal — next decision

If approved, Gate A will add only the local engineering foundation:

- TypeScript and test-runner configuration;
- a reproducible dependency lockfile;
- application configuration validation with placeholder/test values only;
- versioned PostgreSQL migrations derived from the current schema;
- a disposable local test-database workflow;
- a minimal local health endpoint;
- CI commands for install, lint, typecheck, test, and build; and
- documentation that has been verified from a clean checkout.

Gate A will **not** integrate Base, Bankr, Hermes, Telegram, a VPS, or any real wallet
or credential. It will not implement financial classifications or reports. Its sole
purpose is to create a reliable, testable base for the separately approved ingestion
work in Gate B.

Gate A acceptance criteria:

1. dependencies install reproducibly;
2. environment configuration fails closed and never prints secrets;
3. migrations apply to an empty disposable database and can be recreated in tests;
4. lint, typecheck, unit tests, and build pass;
5. the local health endpoint reports process and database readiness separately; and
6. no external API call or wallet access occurs.

**Approval required:** implement Gate A exactly as scoped above, or revise its scope
before any application code is written.
