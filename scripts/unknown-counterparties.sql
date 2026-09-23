-- Unknown counterparty audit
-- Run on VPS: psql "$DATABASE_URL" -f scripts/unknown-counterparties.sql
-- Or use in psql REPL to see what still needs labeling.

-- 1. Addresses generating the most unknown classifications (no rule yet)
SELECT
  CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END AS counterparty,
  ne.direction,
  COUNT(*) AS unknown_count,
  MAX(ne.block_time)::date AS last_seen,
  SUM(COALESCE(ne.usd_value, CASE WHEN ne.asset = 'USDC' THEN ne.amount ELSE NULL END))::numeric(18,2) AS total_usd
FROM classifications c
JOIN normalized_events ne ON ne.id = c.event_id
WHERE c.label = 'unknown'
  AND c.superseded_at IS NULL
GROUP BY counterparty, ne.direction
HAVING COUNT(*) >= 1
ORDER BY unknown_count DESC, total_usd DESC NULLS LAST
LIMIT 20;

-- 2. Total unknown count per user
SELECT u.telegram_id, COUNT(*) AS unknowns
FROM classifications c
JOIN normalized_events ne ON ne.id = c.event_id
JOIN users u ON u.id = ne.user_id
WHERE c.label = 'unknown' AND c.superseded_at IS NULL
GROUP BY u.telegram_id
ORDER BY unknowns DESC;

-- 3. Counterparties with existing rules (for context)
SELECT address, label, name, confidence, source, updated_at::date
FROM counterparty_rules
ORDER BY updated_at DESC
LIMIT 20;
