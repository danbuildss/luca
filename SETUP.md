# Luca Phase 1 Setup

Phase 1 is the local engineering foundation. It does not connect Base, Bankr,
Hermes, Telegram, or a real wallet.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- PostgreSQL 16, or Docker with Docker Compose

## Install

```bash
git clone https://github.com/danbuildss/luca.git
cd luca
cp .env.example .env
npm ci
```

The example configuration uses a local PostgreSQL database and contains no real
credentials.

## Start PostgreSQL

Start the persistent development database:

```bash
docker compose up -d postgres
```

The default `DATABASE_URL` in `.env.example` matches this service.

## Apply Migrations

```bash
npm run db:migrate
```

Migrations are immutable and recorded in `schema_migrations`. The runner refuses to
continue if an already applied migration has been edited.

## Run Luca

```bash
npm run dev
```

This starts:

- the API at `http://127.0.0.1:3000`;
- the worker foundation, which verifies PostgreSQL and then waits for future jobs.

Check the API:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/health` reports process liveness and does not require PostgreSQL. `/ready` returns
HTTP 503 until PostgreSQL is reachable.

## Run Verification

Unit tests do not require PostgreSQL:

```bash
npm test
```

Run the complete disposable-database workflow:

```bash
npm run db:test:up
cp .env.test.example .env.test
set -a
source .env.test
set +a
npm run db:test:migrate
npm run verify
npm run db:test:down
```

The test migration command refuses any database whose name does not end in `_test`.

## Configuration Safety

Startup validates required configuration and exits when it is invalid. Error
responses and configuration errors do not include credential values.

Never commit `.env`. The repository tracks only placeholder examples.

## Deferred Integrations

Hermes, Telegram, Bankr, Base providers, and wallet configuration are intentionally
deferred. Do not copy the files under `hermes/` into a live profile yet; those files
will be reconciled and installed during the approved Hermes phase.
