# Luca Setup Guide

## What Luca is

Luca is a private financial agent for on-chain operators.

He runs on Hermes, uses the Bankr Agent API as his LLM, and talks to you through Telegram.

He watches your wallets, keeps your books, remembers your financial context, and tells you what matters.

---

## Prerequisites

- Mac with Hermes installed
- Bankr account and API key
- Telegram bot token from @BotFather
- Alchemy API key (for Base blockchain data)

---

## Step 1 — Delete the existing Hermes agent

If you have an existing agent in Hermes, back it up first, then clear the workspace:

```bash
cp -r ~/.hermes ~/.hermes-backup
rm -rf ~/.hermes/SOUL.md
rm -rf ~/.hermes/luca
rm -rf ~/.hermes/memories
rm -rf ~/.hermes/skills/luca-finance
```

---

## Step 2 — Clone the repo

```bash
git clone https://github.com/danbuildss/luca.git
cd luca
```

---

## Step 3 — Copy Hermes files into place

```bash
# Core identity
cp hermes/SOUL.md ~/.hermes/SOUL.md
cp hermes/config.yaml ~/.hermes/config.yaml

# Luca project files
mkdir -p ~/.hermes/luca
cp hermes/luca/* ~/.hermes/luca/

# Memory files
mkdir -p ~/.hermes/memories
cp hermes/memories/* ~/.hermes/memories/

# Luca finance skill
mkdir -p ~/.hermes/skills/luca-finance
cp hermes/skills/luca-finance/SKILL.md ~/.hermes/skills/luca-finance/SKILL.md

# Bootstrap file
cp hermes/BOOTSTRAP.md ~/.hermes/BOOTSTRAP.md
```

---

## Step 4 — Set up environment variables

```bash
cp hermes/.env.example ~/.hermes/.env
```

Then open `~/.hermes/.env` and fill in:

- `BANKR_API_KEY` — your Bankr API key
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_ALLOWED_USER_ID` — your Telegram user ID
- `ALCHEMY_API_KEY` — your Alchemy API key
- `OPERATOR_WALLETS` — your wallet addresses (comma-separated)

---

## Step 5 — Start Hermes

```bash
hermes
```

Luca will boot, load his identity, and ask you which wallets to watch.

---

## Step 6 — First conversation

Tell Luca:

> "This is my operations wallet: [YOUR WALLET ADDRESS]. Watch it. Do not execute transactions."

Then:

> "Analyze the last 30 days of activity and give me the first financial report. Separate revenue, expenses, internal transfers, gas, x402 activity and unknowns. Do not guess."

---

## Step 7 — Connect Telegram

Once Luca is running, open Telegram and message your bot.

Luca will respond through Telegram from that point forward.

---

## What Luca will NOT do

- Transfer funds
- Sign transactions
- Swap tokens
- Request your seed phrase or private key
- Depend on Zetta
- Send unsolicited messages unless something material happens

---

## Keeping Luca running on your Mac

To keep Luca running while you work:

```bash
hermes --daemon
```

Or keep the terminal window open.

When you get a VPS, we will migrate Luca there for 24/7 uptime.

---

## Private users

Luca is currently private. Only users you explicitly invite can use it.

To add a private user, add their Telegram user ID to `TELEGRAM_ALLOWED_USER_ID` in `.env`.

---

## Support

Built by danbuildss. Powered by Hermes + Bankr.
