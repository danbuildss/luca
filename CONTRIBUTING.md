# Contributing to Luca

Thanks for helping. Luca keeps people's books, so the bar is correctness first: a small change that is proven right beats a large one that is probably right.

## Before you start

- For anything bigger than a small fix, open an issue first and describe what you want to change and why. It saves you building something that cannot be merged.
- Security problems are never reported in public issues. See [SECURITY.md](SECURITY.md).

## Setup

You need Node 20+ and PostgreSQL 16.

```bash
git clone https://github.com/danbuildss/luca
cd luca
npm ci
cp .env.example .env    # only needed to run the services; tests do not use it
```

For integration tests, create the test database once:

```bash
# with Docker
docker run -d --name luca-pg -e POSTGRES_PASSWORD=luca -p 5432:5432 postgres:16
docker exec luca-pg createdb -U postgres luca_test
```

## Checks

Every pull request must pass the same checks CI runs:

```bash
npm run lint
npm run typecheck
LUCA_INTEGRATION=1 npx vitest run
```

Integration tests run the real SQL against the `luca_test` database and recreate its schema; they refuse to run against a database whose name does not contain `test`.

## Rules that are not negotiable

These are product guarantees. A pull request that weakens one will not be merged.

- **Read-only.** Luca never signs, sends, swaps, approves, trades, bridges or deploys, and never asks for, handles or stores private keys or seed phrases.
- **Operator isolation.** Every query that touches financial data is scoped to one operator. Cross-operator access must be impossible, not just unlikely.
- **The database is the source of truth.** Figures come from the ledger, never from conversation history or model memory.
- **Assets by contract, not symbol.** A token is identified by its contract address. Unsupported tokens never enter the books.
- **No secrets in the repo.** Keys and tokens belong in `.env` only.

## Style

- Match the code around you: its naming, comment density and idiom. TypeScript is strict; lint must be clean.
- Anything Luca says to an operator is plain, professional and friendly, with no emojis (enforced by `tests/style/no-emoji.test.ts`).
- Schema changes go in a new numbered file in `migrations/`. Migrations are additive and safe to re-run; never edit one that has already shipped.
- Tests: a bug fix comes with a test that fails without it. Prefer integration tests for anything that touches SQL.

## Pull requests

- One change per pull request, with a description of what changed, why, and how you verified it.
- Keep commits focused; the title says what the change does.
- By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
