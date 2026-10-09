<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
    <img src="docs/assets/hero-light.svg" alt="Luca: keeps the books on the wallets that work while you sleep. On-chain bookkeeping you talk to in Telegram, on Base, for ETH, USDC and BNKR, read-only. Beside it, a sample of the books: revenue, expenses, swaps, network fees and unknown, with every balance proven against the chain." width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://tally.so/r/J9yy8X"><img src="docs/assets/btn-access.svg" alt="Request access to the private beta" height="34"></a>&nbsp;
  <a href="https://askluca.xyz"><img src="docs/assets/btn-site.svg" alt="askluca.xyz" height="34"></a>&nbsp;
  <a href="https://x.com/AskLucaAI"><img src="docs/assets/btn-x.svg" alt="@AskLucaAI on X" height="34"></a>
</p>

<p align="center">
  <a href="https://github.com/danbuildss/luca/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/danbuildss/luca/ci.yml?branch=main&style=flat-square&label=CI&labelColor=0B0B0A&color=1D7A4C" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-F4F3EE?style=flat-square&labelColor=0B0B0A" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/chain-Base-F4F3EE?style=flat-square&labelColor=0B0B0A" alt="Chain: Base">
  <img src="https://img.shields.io/badge/access-read--only-F4F3EE?style=flat-square&labelColor=0B0B0A" alt="Access: read-only">
  <img src="https://img.shields.io/badge/status-private%20beta-F4F3EE?style=flat-square&labelColor=0B0B0A" alt="Status: private beta">
</p>

Luca is an on-chain bookkeeping agent you talk to in Telegram. Give it your wallets on Base and it keeps your books: what came in, what went out, what it was for, and what it cost in gas. Ask it anything about your money in plain language, and every figure it gives you can be traced back to the transactions on chain.

## What Luca does

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/card-morning-dark.svg">
  <img src="docs/assets/card-morning-light.svg" alt="Example morning message on sample data: Luca lists what came in and went out since yesterday, then two things it couldn't place, numbered, with links to each transaction." width="100%">
</picture>

**One message a morning, only when something happened.** Mondays cover the week. Alerts arrive when something material changes, and nothing is sent between 22:00 and 08:00 in your timezone.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/card-answer-dark.svg">
  <img src="docs/assets/card-answer-light.svg" alt="Example on sample data: the operator answers &quot;1 was revenue, 2 was an expense&quot;; Luca asks &quot;Make these 2 changes?&quot; listing both; the operator says yes; Luca confirms and says new transfers with these addresses will be labeled the same way." width="100%">
</picture>

**Nothing changes without a yes.** Answer in your own words or by number. Luca shows exactly what it will change, then learns the address for every transfer after.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/card-check-dark.svg">
  <img src="docs/assets/card-check-light.svg" alt="Example on sample data: asked to check 30 days of books, Luca re-reads two wallets against the chain and reports 214 transactions and 231 supported movements, every one of them in the books." width="100%">
</picture>

**Books proven against the chain.** Ask any time, and Luca re-reads the chain and says exactly what it covered and what, if anything, is missing.

<sub>The chat cards show Luca's real messages, produced by its own code on sample data. No real wallet, address or amount appears in them.</sub>

<details>
<summary><b>Everything Luca does today</b></summary>
<br>

**Keeps complete books**
- Watches your Base wallets every minute, for ETH, USDC and BNKR. Tokens are identified by contract address, so look-alike tokens and spam never enter the books.
- Records every transfer with its exact on-chain amount, and the network fee of every transaction you send, including failed ones.
- Double-checks USDC and BNKR against the token contracts' own transfer records and fills in anything the main data feed missed.
- Keeps zero-value "address poisoning" transfers, and tiny unsolicited ones, out of the books.

**Proves the books against the chain**
- Every hour, for each wallet and asset, the balance the books add up to must equal the balance on chain, to the smallest unit.
- When it does not, Luca finds the exact block where they diverge, re-reads it, and repairs the gap. If it cannot explain the difference, it says so plainly instead of showing numbers it cannot stand behind.

**Labels every transaction, carefully**
- Looks at each transaction as a whole: network fees, moves between your own wallets and swaps (one asset converted into another, which is neither income nor spending) are recognised from the transaction itself.
- Learns from your answers: tell it once what an address is and it labels that address's earlier and future transfers the same way. It never learns a rule from an exchange contract, and a correction that contradicts a rule switches the rule off.
- Uses AI only as a last resort, and marks those labels as provisional until you or a rule confirms them. Totals show how much of them is a guess.
- Asks about unknown transfers in groups ("4 USDC payments to 0xabc… ($1,240.00 total)"), once, as one numbered list in the morning message (at most three a day); a large one is asked about in its own alert. Small ones get one line on Mondays.

**Prices from the chain itself**
- ETH at Chainlink's ETH/USD price at the transaction's block.
- BNKR at the price you actually traded it at, or the Uniswap BNKR/WETH pool's 30-minute average at that block.
- USDC at $1, with an alert if Chainlink shows it off its peg.
- Every price source is checked on chain before it is used, and every transfer records where its price came from.

**Answers in chat**
- "What does the last month look like?", "Where does my gas come from?", "What was that $500 on Tuesday?"
- A yes/no question before anything in your books is changed.

</details>

## Principles

- **Read-only.** Luca only needs public wallet addresses. It cannot sign, send or move anything.
- **The database is the only source of financial truth.** Answers come from the books, never from a chat model's memory.
- **Prices come from the chain.** Every price records its source, and every source is checked on chain first.
- **History is never overwritten.** A correction is recorded next to the label it replaced, with the operator's own words and the rule it taught.
- **Nothing changes without a yes.** Every change to your books is one question you answer.
- **Proven, or said plainly.** When the books and the chain disagree and Luca cannot explain why, it says so instead of showing the number.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/flow-books-dark.svg">
  <img src="docs/assets/flow-books-light.svg" alt="How Luca keeps your books, in five stages: Base (every transfer and network fee, read from the chain), Ingestion (raw evidence kept, cross-checked against token transfer logs), Ledger (balances proven to the smallest unit, every hour), Labels (transaction shape, then your rules, then AI as a guess), and You (morning message, alerts and answers in Telegram). Ingestion, ledger and labels share one PostgreSQL database, the only source of financial truth." width="100%">
</picture>

Three services share that one database:

| Service | Entry point | Role |
|---------|-------------|------|
| `luca-worker` | `apps/worker/index.ts` | Every 60 s: sync wallets, prove balances, price, classify, ask, alert |
| `luca-telegram` | `apps/telegram/index.ts` | Telegram bot: chat agent, questions, confirmations |
| `luca-api` | `apps/api/index.ts` | Internal API (Fastify, bound to localhost) and ops page |

**Stack:** TypeScript on Node 20+, Telegraf, Fastify, PostgreSQL (Supabase in production), Alchemy for Base RPC and transfers, Blockscout as a fallback, OpenAI-compatible LLM APIs, Vitest. More in [docs/architecture.md](docs/architecture.md) and [docs/operating-rules.md](docs/operating-rules.md).

### Teach it once

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/flow-teach-dark.svg">
  <img src="docs/assets/flow-teach-light.svg" alt="Teach Luca once, in five steps: Luca asks about a transfer it can't place; you answer in your own words or by number; Luca lists exactly what will change and waits for yes; it learns, so that address is labeled the same way before and after; and the old label stays on record with your words and the rule it taught." width="100%">
</picture>

## What Luca does not do

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/never-dark.svg">
  <img src="docs/assets/never-light.svg" alt="Read-only by design. Luca never signs a transaction, moves or sends funds, swaps, trades or bridges, approves a contract, asks for keys or seed phrases, or shows your books to another user." width="100%">
</picture>

Luca is read-only. It never signs transactions, moves funds, swaps, approves contracts, trades or bridges, and it never asks for or stores private keys or seed phrases. Each operator's data is scoped to them; one operator can never see another's.

Luca is not tax, legal or investment advice. Today it covers Base only, and ETH, USDC and BNKR only.

## Run it yourself

You need Node 20+, PostgreSQL 16, an [Alchemy](https://www.alchemy.com) API key for Base, a Telegram bot token from [@BotFather](https://t.me/BotFather), and an OpenAI API key (or any OpenAI-compatible endpoint).

```bash
git clone https://github.com/danbuildss/luca
cd luca
npm ci
cp .env.example .env      # then fill it in
npm run db:migrate        # applies every migration in migrations/ in order
npm run dev               # worker, bot and API with reload
```

<details>
<summary><b>Environment variables</b></summary>
<br>

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | yes | Telegram bot token |
| `ALCHEMY_API_KEY` | yes | Base RPC, transfers, receipts, logs and on-chain prices |
| `OPENAI_API_KEY` | one LLM key | The agent and the classifier on OpenAI, unless `AGENT_LLM_KEY` is set |
| `AGENT_LLM_KEY` / `AGENT_BASE_URL` / `AGENT_MODEL` | one LLM key | Use an OpenAI-compatible gateway (key, endpoint, model) for both the agent and the classifier |
| `CLASSIFIER_MODEL` | no | Classifier model (default: `AGENT_MODEL` on a gateway, `gpt-4o-mini` on OpenAI) |
| `COINGECKO_API_KEY` / `COINGECKO_API_TIER` | no | Fallback prices; works without a key at a lower rate limit |
| `LLM_DAILY_SPEND_CAP_USD` | no | Daily AI spend cap (default $1.00) |
| `LUCA_ADMIN_KEY` | no | Admin key for invite management over the API |

</details>

Production runs as systemd services on a Linux VPS; see [docs/deployment.md](docs/deployment.md).

### Tests

```bash
npm run lint && npm run typecheck
npx vitest run                                  # unit tests
LUCA_INTEGRATION=1 npx vitest run               # plus integration tests against Postgres
```

Integration tests need a PostgreSQL at `postgresql://postgres:luca@localhost:5432/luca_test` (see [vitest.config.ts](vitest.config.ts)); they drop and recreate the schema of that test database only.

<details>
<summary><b>Project structure</b></summary>
<br>

```
luca/
├── apps/            # worker, telegram bot, api
├── src/
│   ├── ingestion/   # chain reads, normalization, gas, token-log cross-check, pricing at ingest
│   ├── ledger/      # hourly balance proof and repair
│   ├── classification/  # transaction shapes, rules, AI fallback
│   ├── corrections/ # operator corrections and learned rules
│   ├── pricing/     # Chainlink and Uniswap reads, USDC peg watch
│   ├── books/       # P&L, overview, balances, per-figure breakdowns
│   ├── alerts/      # grouped questions and alert detectors
│   ├── agent/       # chat agent, tools, guardrails
│   └── telegram/    # bot commands, callbacks, formatting
├── migrations/      # PostgreSQL migrations, applied in order
├── prompts/         # the agent's system prompt
├── scripts/         # operations scripts, and the README graphics (readme-assets/)
├── tests/           # unit and integration tests
├── docs/            # architecture, deployment, operating rules, README graphics
└── landing/         # askluca.xyz
```

</details>

## Docs

<p>
  <a href="docs/architecture.md"><img src="docs/assets/doc-architecture.svg" alt="Architecture" height="34"></a>&nbsp;
  <a href="docs/operating-rules.md"><img src="docs/assets/doc-rules.svg" alt="Operating rules" height="34"></a>&nbsp;
  <a href="docs/deployment.md"><img src="docs/assets/doc-deployment.svg" alt="Deployment" height="34"></a>&nbsp;
  <a href="SECURITY.md"><img src="docs/assets/doc-security.svg" alt="Security" height="34"></a>&nbsp;
  <a href="CONTRIBUTING.md"><img src="docs/assets/doc-contributing.svg" alt="Contributing" height="34"></a>
</p>

> **Using a coding agent?** Point it at [docs/architecture.md](docs/architecture.md) and [CONTRIBUTING.md](CONTRIBUTING.md) first. Every change must keep Luca read-only and every query scoped to one operator.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and report security issues privately as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Copyright 2026 Luca contributors. Licensed under the [Apache License, Version 2.0](LICENSE). The README graphics embed Geist, Geist Mono and Newsreader under the [SIL Open Font License](scripts/readme-assets/fonts/).
