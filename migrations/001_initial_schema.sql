-- Migration 001: Initial schema
-- Includes all tables from design doc + CEO plan additions.
-- PostgreSQL 16. Uses standard SQL only — no SQLite-isms.

-- Required extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Classification label constraint (canonical 9-label set)
DO $$ BEGIN
  CREATE TYPE classification_label AS ENUM (
    'revenue',
    'expense',
    'internal_transfer',
    'treasury',
    'gas',
    'x402_income',
    'x402_spend',
    'refund',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  materiality_usd NUMERIC NOT NULL DEFAULT 50 CHECK (materiality_usd >= 0),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  brief_time TEXT NOT NULL DEFAULT '08:00',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Wallets
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base' CHECK (chain IN ('base', 'solana')),
  label TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, address, chain)
);

-- Wallet Roles
CREATE TABLE IF NOT EXISTS wallet_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('operations', 'treasury', 'revenue', 'expenses', 'agent', 'personal')),
  set_by TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_id, role)
);

-- Raw Transactions (immutable chain observations)
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  chain TEXT NOT NULL DEFAULT 'base',
  hash TEXT NOT NULL,
  block_number BIGINT,
  block_time TIMESTAMPTZ NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT,
  asset TEXT,
  amount NUMERIC,
  usd_value NUMERIC,
  gas_used NUMERIC,
  gas_price NUMERIC,
  gas_usd NUMERIC,
  direction TEXT CHECK (direction IN ('in', 'out')),
  tx_type TEXT CHECK (tx_type IN ('transfer', 'swap', 'contract_call', 'internal')),
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chain, hash, wallet_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_block_time ON transactions(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_address);

-- Normalized Events (one event per economic movement, incl. gas as separate event)
CREATE TABLE IF NOT EXISTS normalized_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain TEXT NOT NULL DEFAULT 'base',
  hash TEXT NOT NULL,
  log_index INTEGER,                -- for ERC-20 log events; NULL for native transfers
  block_time TIMESTAMPTZ NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT,
  asset TEXT,
  amount NUMERIC,
  usd_value NUMERIC,
  price_source TEXT,                -- 'alchemy', 'coingecko', 'fixed:1.00'
  price_at TIMESTAMPTZ,             -- timestamp of the price used
  direction TEXT CHECK (direction IN ('in', 'out')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique
  ON normalized_events(chain, hash, wallet_id, COALESCE(log_index, -1));

CREATE INDEX IF NOT EXISTS idx_events_user_id ON normalized_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_block_time ON normalized_events(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_wallet_id ON normalized_events(wallet_id);

-- Classifications (one active row per event — latest wins on conflict)
CREATE TABLE IF NOT EXISTS classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES normalized_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label classification_label NOT NULL,
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  method TEXT NOT NULL CHECK (method IN ('deterministic', 'counterparty', 'pattern', 'model')),
  evidence TEXT,
  superseded_at TIMESTAMPTZ,        -- NULL = active; set when a newer classification overwrites
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_classifications_event_id ON classifications(event_id);
CREATE INDEX IF NOT EXISTS idx_classifications_user_id ON classifications(user_id);
CREATE INDEX IF NOT EXISTS idx_classifications_label ON classifications(label);
-- Partial index: only active classifications
CREATE INDEX IF NOT EXISTS idx_classifications_active ON classifications(event_id) WHERE superseded_at IS NULL;

-- Counterparty Rules (learned from user corrections)
CREATE TABLE IF NOT EXISTS counterparty_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  label classification_label NOT NULL,
  name TEXT,
  confidence NUMERIC NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, address)
);

CREATE INDEX IF NOT EXISTS idx_counterparty_user_id ON counterparty_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_counterparty_address ON counterparty_rules(address);

-- Corrections (tx-level or counterparty-level — both types stored here)
CREATE TABLE IF NOT EXISTS corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('tx', 'counterparty')),
  event_id UUID REFERENCES normalized_events(id),   -- for type='tx'
  counterparty_address TEXT,                         -- for type='counterparty'
  old_label classification_label,
  new_label classification_label NOT NULL,
  reason TEXT,
  source_message TEXT,                               -- original Telegram message text
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_corrections_user_id ON corrections(user_id);
CREATE INDEX IF NOT EXISTS idx_corrections_type ON corrections(type);
CREATE INDEX IF NOT EXISTS idx_corrections_counterparty ON corrections(counterparty_address);

-- Memory Entries (Hermes agent context — NOT financial truth)
CREATE TABLE IF NOT EXISTS memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('wallet_role', 'counterparty', 'vendor', 'threshold', 'preference')),
  value JSONB NOT NULL,
  confidence NUMERIC NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_user_id ON memory_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);

-- Briefs (generated and delivered reports)
CREATE TABLE IF NOT EXISTS briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('daily', 'weekly', 'anomaly')),
  content TEXT NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  telegram_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_briefs_user_id ON briefs(user_id);
CREATE INDEX IF NOT EXISTS idx_briefs_created_at ON briefs(created_at DESC);

-- Alerts
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'new_counterparty', 'spend_spike', 'treasury_floor',
    'round_trip', 'unknown_high', 'large_inflow', 'large_outflow',
    'unusual_gas', 'x402_anomaly'
  )),
  message TEXT NOT NULL,
  evidence JSONB,
  dedup_key TEXT UNIQUE,           -- prevents duplicate alert sends
  sent_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);

-- Watch Jobs (per-wallet sync state)
CREATE TABLE IF NOT EXISTS watch_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMPTZ,
  last_block BIGINT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_id)
);

-- Sync Runs (audit log of every ingestion run)
CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'alchemy',
  chain TEXT NOT NULL DEFAULT 'base',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  events_ingested INTEGER NOT NULL DEFAULT 0,
  events_classified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  error_message TEXT
);

-- Balance Snapshots (taken after every sync — required for /runway treasury computation)
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset TEXT NOT NULL,
  balance NUMERIC NOT NULL CHECK (balance >= 0),
  snapshot_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_id, asset, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_wallet_id ON balance_snapshots(wallet_id);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_user_id ON balance_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_snapshot_at ON balance_snapshots(snapshot_at DESC);

-- MCP API Keys (auth for agent-to-agent financial context queries)
CREATE TABLE IF NOT EXISTS mcp_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the token; never store raw token
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caller_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_keys_key_hash ON mcp_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_keys_user_id ON mcp_keys(user_id);

-- Pending Counterparty Alerts (state machine for unknown wallet labeling)
CREATE TABLE IF NOT EXISTS pending_counterparty_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  counterparty_address TEXT NOT NULL,
  watched_wallet_address TEXT NOT NULL,
  telegram_message_id BIGINT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'labeled', 'skipped', 'timed_out')),
  resolved_at TIMESTAMPTZ,
  UNIQUE(user_id, counterparty_address)  -- one active alert per unknown counterparty per user
);

CREATE INDEX IF NOT EXISTS idx_counterparty_alerts_user_id ON pending_counterparty_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_counterparty_alerts_status ON pending_counterparty_alerts(status);
CREATE INDEX IF NOT EXISTS idx_counterparty_alerts_sent_at ON pending_counterparty_alerts(sent_at);

-- LLM Spend Tracking (circuit breaker: halt LLM calls if daily spend exceeds cap)
CREATE TABLE IF NOT EXISTS llm_spend_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  purpose TEXT,                    -- 'classification', 'brief', 'investigation'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_spend_created_at ON llm_spend_log(created_at DESC);
