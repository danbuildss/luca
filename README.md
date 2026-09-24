# Luca

> Luca is the employee who keeps books on the wallets that work while you sleep.

Luca is an on-chain bookkeeping agent you talk to in Telegram. Give it your wallets on Base and it keeps your books: what came in, what went out, what it was for, and what it cost in gas. Ask it anything about your money in plain language and every figure it gives you can be traced back to the transactions on chain.

Website: [askluca.xyz](https://askluca.xyz) · Status: invite-only beta · License: [Apache-2.0](LICENSE)

## What Luca does today

**Keeps complete books**
- Watches your Base wallets every minute, for ETH, USDC and BNKR. Tokens are identified by contract address, so look-alike tokens and spam never enter the books.
- Records every transfer with its exact on-chain amount, and the network fee of every transaction you send, including failed ones.
- Double-checks USDC and BNKR against the token contracts' own transfer records and fills in anything the main data feed missed.
- Keeps zero-value "address poisoning" transfers out of the books.

**Proves the books against the chain**
- Every hour, for each wallet and asset, the balance the books add up to must equal the balance on chain, to the smallest unit.
- When it does not, Luca finds the exact block where they diverge, re-reads it, and repairs the gap. If it cannot explain the difference, it says so plainly instead of showing numbers it cannot stand behind.

**Labels every transaction, carefully**
- Looks at each transaction as a whole: network fees, moves between your own wallets and swaps (one asset converted into another, which is neither income nor spending) are recognised from the transaction itself.
- Learns from your answers: tell it once what an address is and it labels that address's earlier and future transfers the same way. It never learns a rule from an exchange contract, and a correction that contradicts a rule switches the rule off.
- Uses AI only as a last resort, and marks those labels as provisional until you or a rule confirms them. Totals show how much of them is a guess.
- Asks about unknown transfers in groups ("4 outgoing USDC payments to 0xabc…, $1,240 total"), at most three questions a day; small ones wait for the daily brief.

**Prices from the chain itself**
- ETH at Chainlink's ETH/USD price at the transaction's block.
- BNKR at the price you actually traded it at, or the Uniswap BNKR/WETH pool's 30-minute average at that block.
- USDC at $1, with an alert if Chainlink shows it off its peg.
- Every price source is checked on chain before it is used, and every transfer records where its price came from.

**Answers in chat**
- "What does the last month look like?", "Where does my gas come from?", "What was that $500 on Tuesday?"
- Daily and weekly briefs, alerts on material changes, and a Confirm / Cancel step before anything is changed.

## What Luca does not do

Luca is read-only. It never signs transactions, moves funds, swaps, approves contracts, trades or bridges, and it never asks for or stores private keys or seed phrases. Each operator's data is scoped to them; one operator can never see another's.

Luca is not tax, legal or investment advice. Today it covers Base only, and ETH, USDC and BNKR only.

## How it runs

Three services share one PostgreSQL database, which is the only source of financial truth:

| Service | Entry point | Role |
|---------|-------------|------|
| `luca-worker` | `apps/worker/index.ts` | Every 60 s: sync wallets, prove balances, price, classify, ask, alert |
| `luca-telegram` | `apps/telegram/index.ts` | Telegram bot: chat agent, questions, confirmations |
| `luca-api` | `apps/api/index.ts` | Internal API (Fastify, bound to localhost) and ops page |

```
Base (Alchemy, Blockscout, Chainlink, Uniswap)
      ↓
Ingestion ── raw evidence, gas, token-log cross-check
      ↓
Ledger ───── hourly balance proof against the chain
      ↓
Classification ── whole-transaction shapes → learned rules → AI (provisional)
      ↓
Books, questions, briefs, alerts ── Telegram
```

More in [docs/architecture.md](docs/architecture.md) and [docs/operating-rules.md](docs/operating-rules.md).

**Stack:** TypeScript on Node 20+, Telegraf, Fastify, PostgreSQL (Supabase in production), Alchemy for Base RPC and transfers, Blockscout as a fallback, OpenAI-compatible LLM APIs, Vitest.

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

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | yes | Telegram bot token |
| `ALCHEMY_API_KEY` | yes | Base RPC, transfers, receipts, logs and on-chain prices |
| `OPENAI_API_KEY` | yes | Classification model, and the agent unless `AGENT_LLM_KEY` is set |
| `AGENT_LLM_KEY` / `AGENT_BASE_URL` / `AGENT_MODEL` | no | Use a different key, OpenAI-compatible endpoint or model for the chat agent |
| `COINGECKO_API_KEY` / `COINGECKO_API_TIER` | no | Fallback prices; works without a key at a lower rate limit |
| `LLM_DAILY_SPEND_CAP_USD` | no | Daily AI spend cap (default $1.00) |
| `LUCA_ADMIN_KEY` | no | Admin key for invite management over the API |

Production runs as systemd services on a Linux VPS; see [docs/deployment.md](docs/deployment.md).

## Tests

```bash
npm run lint && npm run typecheck
npx vitest run                                  # unit tests
LUCA_INTEGRATION=1 npx vitest run               # plus integration tests against Postgres
```

Integration tests need a PostgreSQL at `postgresql://postgres:luca@localhost:5432/luca_test` (see [vitest.config.ts](vitest.config.ts)); they drop and recreate the schema of that test database only.

## Project structure

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
├── tests/           # unit and integration tests
├── docs/            # architecture, deployment, operating rules
└── landing/         # askluca.xyz
```

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and report security issues privately as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Copyright 2026 Luca contributors. Licensed under the [Apache License, Version 2.0](LICENSE).
