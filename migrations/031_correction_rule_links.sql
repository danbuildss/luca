-- Migration 031: link older corrections to the rule they taught
--
-- Additive. 030 filled corrections.rule_id only where a proposal recorded the link, which
-- happens only when earlier transfers existed to relabel; none of the corrections at the
-- time had one. A rule is unique per operator, address and direction, so a correction
-- that taught a rule points to exactly one: the rule for its transfer's counterparty and
-- direction. Checked against production on Oct 5 before writing this (5 of 5 matched).

UPDATE corrections c
SET rule_id = r.id
FROM normalized_events ne, counterparty_rules r
WHERE ne.id = c.event_id
  AND c.created_rule
  AND c.rule_id IS NULL
  AND c.counterparty_address IS NOT NULL
  AND r.user_id = c.user_id
  AND r.address = LOWER(c.counterparty_address)
  AND r.direction = ne.direction;
