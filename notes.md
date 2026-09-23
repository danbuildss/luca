# Luca — Product & Architecture Notes

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
| 8 | WhatsApp (second channel) | Channel switch doesn't change memory or financial understanding |
| 9 | iMessage + other channels | Add a surface without touching the accounting engine |
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
TelegramAdapter
WhatsAppAdapter     →  Luca Agent  →  Luca Core
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
