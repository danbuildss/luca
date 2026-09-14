-- Luca Database Schema
-- Postgres 16

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE,
  telegram_username TEXT,
  materiality_usd NUMERIC DEFAULT 50,
  timezone TEXT DEFAULT 'UTC',
  brief_time TEXT DEFAULT '08:00',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Wallets
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base',
  label TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, address, chain)
);

-- Wallet Roles
CREATE TABLE wallet_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- ops, treasury, payments_in, expenses, cold
  set_by TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(wallet_id, role)
);

-- Raw Transactions
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
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
  direction TEXT, -- in, out
  tx_type TEXT, -- transfer, swap, contract_call, internal
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chain, hash, wallet_id)
);

CREATE INDEX idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX idx_transactions_block_time ON transactions(block_time DESC);
CREATE INDEX idx_transactions_from ON transactions(from_address);
CREATE INDEX idx_transactions_to ON transactions(to_address);

-- Normalized Events
CREATE TABLE normalized_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  chain TEXT NOT NULL DEFAULT 'base',
  hash TEXT NOT NULL,
  block_time TIMESTAMPTZ NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT,
  asset TEXT,
  amount NUMERIC,
  usd_value NUMERIC,
  direction TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_user_id ON normalized_events(user_id);
CREATE INDEX idx_events_block_time ON normalized_events(block_time DESC);

-- Classifications
CREATE TABLE classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES normalized_events(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, -- revenue, x402_income, expenses, x402_spend, treasury, internal, gas, unknown
  confidence NUMERIC,
  method TEXT, -- deterministic, pattern, learned, model
  evidence TEXT,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_classifications_event_id ON classifications(event_id);
CREATE INDEX idx_classifications_user_id ON classifications(user_id);
CREATE INDEX idx_classifications_label ON classifications(label);

-- Counterparty Rules
CREATE TABLE counterparty_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  label TEXT NOT NULL,
  name TEXT,
  confidence NUMERIC DEFAULT 1.0,
  source TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, address)
);

CREATE INDEX idx_counterparty_user_id ON counterparty_rules(user_id);
CREATE INDEX idx_counterparty_address ON counterparty_rules(address);

-- Memory Entries
CREATE TABLE memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  type TEXT NOT NULL, -- wallet_role, counterparty, vendor, threshold, preference
  value JSONB NOT NULL,
  confidence NUMERIC DEFAULT 1.0,
  source TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memory_user_id ON memory_entries(user_id);
CREATE INDEX idx_memory_type ON memory_entries(type);

-- Corrections
CREATE TABLE corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID REFERENCES normalized_events(id),
  old_label TEXT,
  new_label TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_corrections_user_id ON corrections(user_id);

-- Briefs
CREATE TABLE briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- daily, weekly, anomaly
  content TEXT NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_briefs_user_id ON briefs(user_id);
CREATE INDEX idx_briefs_created_at ON briefs(created_at DESC);

-- Alerts
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- new_counterparty, spend_spike, treasury_floor, round_trip, unknown_high
  message TEXT NOT NULL,
  evidence JSONB,
  sent_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_user_id ON alerts(user_id);
CREATE INDEX idx_alerts_created_at ON alerts(created_at DESC);

-- Watch Jobs
CREATE TABLE watch_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMPTZ,
  last_block BIGINT,
  status TEXT DEFAULT 'active',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sync Runs
CREATE TABLE sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  events_ingested INTEGER DEFAULT 0,
  events_classified INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  error_message TEXT
);
