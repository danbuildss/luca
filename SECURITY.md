# Security

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:
[Report a vulnerability](https://github.com/danbuildss/luca/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an acknowledgement within a few days, and we will keep you updated until it is fixed. We are glad to credit you once a fix is released.

## What Luca guarantees

These are the properties a report is most useful against:

- **Read-only.** Luca never signs transactions, moves funds, swaps, approves contracts, trades, bridges or deploys. It never asks for, handles or stores private keys or seed phrases.
- **Operator isolation.** Every financial read and write is scoped to the authenticated operator. One operator must never be able to see or change another's data.
- **Confirmed changes only.** Changes the chat agent proposes (relabels, new wallets) run only after the operator taps Confirm.
- **Untrusted chain data.** Token names, counterparty names and other chain-controlled text are treated as data, never as instructions to the agent.
- **No secrets in code.** Keys and tokens live only in the deployment's environment.

## In scope

The code in this repository: ingestion, the ledger and balance proof, classification, pricing, the chat agent and its tools, the Telegram bot and the internal API.

Out of scope: third-party services Luca reads from (Alchemy, Blockscout, Chainlink, Uniswap, CoinGecko, OpenAI, Telegram), and denial of service through volume alone.
