# Luca Deployment Status

Production deployment is not part of Phase 1. This document records the supported
development topology and the boundary for the later VPS phase.

## Development Topology

```text
Mac
├── Luca API
├── Luca worker foundation
└── PostgreSQL 16
```

Use Docker Compose for PostgreSQL when Docker is available:

```bash
docker compose up -d postgres
npm run db:migrate
npm run dev
```

The application can also use any PostgreSQL 16 instance configured through
`DATABASE_URL`.

## Process Checks

- `GET /health` verifies that the API process is alive.
- `GET /ready` verifies that the API can reach PostgreSQL.
- The worker verifies PostgreSQL before declaring itself ready.

Neither endpoint exposes connection strings or provider errors.

## Production Boundary

The VPS phase will define and verify:

- a dedicated Linux user;
- system services for the API, worker, scheduler, and Hermes gateway;
- a private PostgreSQL service;
- firewall and SSH policy;
- secret storage and rotation;
- structured log redaction and rotation;
- encrypted backups and a restore drill;
- rollback and degraded-mode procedures.

Do not deploy the Phase 1 worker as a financial service. It contains no ingestion,
classification, reporting, Bankr, Telegram, or monitoring jobs.
