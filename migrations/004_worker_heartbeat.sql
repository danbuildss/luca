-- Migration 004: Worker heartbeat + health alerts
-- Tracks worker liveness and enables staleness detection.

CREATE TABLE IF NOT EXISTS worker_heartbeat (
  id            INT         PRIMARY KEY DEFAULT 1,
  last_ping_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  loop_count    BIGINT      NOT NULL DEFAULT 0,
  CHECK (id = 1)
);

-- Seed the single row; worker will update it on each loop.
INSERT INTO worker_heartbeat (id, last_ping_at, loop_count)
VALUES (1, NOW(), 0)
ON CONFLICT (id) DO NOTHING;
