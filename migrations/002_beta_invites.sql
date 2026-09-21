-- Migration 002: Beta invite gating
-- Controls who can access Luca during private beta.
-- Checked by /users/resolve — telegram_id must be 'active' to create/access an account.

CREATE TABLE IF NOT EXISTS beta_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL UNIQUE,
  telegram_username TEXT,
  invited_by TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_beta_invites_telegram_id ON beta_invites(telegram_id);
CREATE INDEX IF NOT EXISTS idx_beta_invites_status ON beta_invites(status);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luca') THEN
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA public TO luca';
    EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO luca';
  END IF;
END $$;
