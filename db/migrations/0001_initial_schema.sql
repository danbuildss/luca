CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE wallet_role AS ENUM ('operations', 'treasury', 'personal', 'revenue', 'agent');
CREATE TYPE event_direction AS ENUM ('in', 'out');
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
CREATE TYPE classification_method AS ENUM (
  'explicit_correction',
  'learned_rule',
  'ownership_rule',
  'protocol_rule',
  'gas_rule',
  'model_proposal',
  'unknown'
);
CREATE TYPE confidence_level AS ENUM ('high', 'medium', 'low');
CREATE TYPE job_status AS ENUM ('idle', 'running', 'succeeded', 'failed');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE,
  telegram_username TEXT,
  materiality_usd NUMERIC(30, 8) NOT NULL DEFAULT 50 CHECK (materiality_usd >= 0),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  brief_time TIME NOT NULL DEFAULT '08:00',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL CHECK (address = LOWER(address) AND address ~ '^0x[0-9a-f]{40}$'),
  chain TEXT NOT NULL DEFAULT 'base' CHECK (chain = 'base'),
  label TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, chain, address)
);

CREATE INDEX wallets_user_id_idx ON wallets(user_id);

CREATE TABLE wallet_role_assignments (
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  role wallet_role NOT NULL,
  set_by TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_id, role)
);

CREATE TABLE raw_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL CHECK (chain = 'base'),
  provider TEXT NOT NULL,
  source_key TEXT NOT NULL,
  block_number BIGINT,
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, provider, source_key)
);

CREATE INDEX raw_observations_block_number_idx ON raw_observations(chain, block_number);

CREATE TABLE chain_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL CHECK (chain = 'base'),
  hash TEXT NOT NULL CHECK (hash = LOWER(hash) AND hash ~ '^0x[0-9a-f]{64}$'),
  block_number BIGINT NOT NULL,
  transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
  block_time TIMESTAMPTZ NOT NULL,
  from_address TEXT NOT NULL CHECK (from_address = LOWER(from_address)),
  to_address TEXT CHECK (to_address IS NULL OR to_address = LOWER(to_address)),
  native_value_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (native_value_atomic >= 0),
  gas_used NUMERIC(78, 0) NOT NULL CHECK (gas_used >= 0),
  effective_gas_price NUMERIC(78, 0) NOT NULL CHECK (effective_gas_price >= 0),
  succeeded BOOLEAN NOT NULL,
  final BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, hash)
);

CREATE INDEX chain_transactions_block_idx ON chain_transactions(chain, block_number, transaction_index);
CREATE INDEX chain_transactions_time_idx ON chain_transactions(block_time DESC);

CREATE TABLE financial_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES chain_transactions(id) ON DELETE CASCADE,
  raw_observation_id UUID REFERENCES raw_observations(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  log_index INTEGER,
  block_number BIGINT NOT NULL,
  block_time TIMESTAMPTZ NOT NULL,
  direction event_direction NOT NULL,
  from_address TEXT NOT NULL CHECK (from_address = LOWER(from_address)),
  to_address TEXT CHECK (to_address IS NULL OR to_address = LOWER(to_address)),
  asset_symbol TEXT NOT NULL,
  token_address TEXT CHECK (token_address IS NULL OR token_address = LOWER(token_address)),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic >= 0),
  asset_decimals INTEGER NOT NULL CHECK (asset_decimals BETWEEN 0 AND 36),
  usd_value NUMERIC(38, 18) CHECK (usd_value IS NULL OR usd_value >= 0),
  valuation_price NUMERIC(38, 18) CHECK (valuation_price IS NULL OR valuation_price >= 0),
  valuation_source TEXT,
  valuation_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_id, source_key)
);

CREATE INDEX financial_events_user_time_idx ON financial_events(user_id, block_time DESC);
CREATE INDEX financial_events_wallet_idx ON financial_events(wallet_id);
CREATE INDEX financial_events_transaction_idx ON financial_events(transaction_id);

CREATE TABLE classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL UNIQUE REFERENCES financial_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label classification_label NOT NULL DEFAULT 'unknown',
  confidence confidence_level NOT NULL DEFAULT 'low',
  method classification_method NOT NULL DEFAULT 'unknown',
  evidence JSONB NOT NULL DEFAULT '[]'::JSONB,
  rule_version TEXT NOT NULL DEFAULT 'v1',
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX classifications_user_label_idx ON classifications(user_id, label);

CREATE TABLE counterparty_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL CHECK (address = LOWER(address) AND address ~ '^0x[0-9a-f]{40}$'),
  direction event_direction,
  asset_symbol TEXT,
  label classification_label NOT NULL,
  name TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (user_id, address, direction, asset_symbol)
);

CREATE INDEX counterparty_rules_user_idx ON counterparty_rules(user_id);

CREATE TABLE corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES financial_events(id) ON DELETE CASCADE,
  old_label classification_label NOT NULL,
  new_label classification_label NOT NULL,
  reason TEXT,
  creates_rule BOOLEAN NOT NULL DEFAULT FALSE,
  corrected_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (old_label <> new_label)
);

CREATE INDEX corrections_user_idx ON corrections(user_id, created_at DESC);

CREATE TABLE balance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  asset_symbol TEXT NOT NULL,
  token_address TEXT,
  balance_atomic NUMERIC(78, 0) NOT NULL CHECK (balance_atomic >= 0),
  asset_decimals INTEGER NOT NULL CHECK (asset_decimals BETWEEN 0 AND 36),
  block_number BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE NULLS NOT DISTINCT (wallet_id, asset_symbol, token_address, block_number)
);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  cutoff_block BIGINT,
  rule_version TEXT NOT NULL,
  payload JSONB NOT NULL,
  content TEXT,
  delivery_key TEXT UNIQUE,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end > period_start)
);

CREATE INDEX reports_user_period_idx ON reports(user_id, period_end DESC);

CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,
  deduplication_key TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::JSONB,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, deduplication_key)
);

CREATE TABLE sync_state (
  wallet_id UUID PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
  next_block BIGINT,
  last_finalized_block BIGINT,
  status job_status NOT NULL DEFAULT 'idle',
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  from_block BIGINT,
  to_block BIGINT,
  status job_status NOT NULL DEFAULT 'running',
  observations_stored INTEGER NOT NULL DEFAULT 0 CHECK (observations_stored >= 0),
  events_stored INTEGER NOT NULL DEFAULT 0 CHECK (events_stored >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX sync_runs_wallet_started_idx ON sync_runs(wallet_id, started_at DESC);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_user_time_idx ON audit_log(user_id, created_at DESC);
