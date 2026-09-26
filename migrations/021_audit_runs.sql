-- Migration 021: durable book-completeness checks
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- A check of an operator's books against the chain ("are my books complete?") runs in
-- the background and can take minutes. Each run is recorded so a restart mid-check is
-- known (status 'interrupted') and retried, the result can be reused while the books
-- have not changed, and the operator is told the outcome exactly once (delivered_at).

CREATE TABLE IF NOT EXISTS audit_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- whose wallets
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,          -- who asked (the operator or an admin)
  days          INTEGER,                                               -- NULL = everything tracked
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'complete', 'failed', 'interrupted')),
  attempts      INTEGER NOT NULL DEFAULT 1,
  signature     TEXT,     -- state of the books when checked; unchanged = the result still holds
  result        JSONB,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audit_runs_user ON audit_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_runs_running ON audit_runs(status) WHERE status = 'running';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luca') THEN
    EXECUTE 'GRANT ALL ON audit_runs TO luca';
  END IF;
END $$;
