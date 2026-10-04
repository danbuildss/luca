-- Migration 029: the morning message (week of Oct 4, PR 2)
--
-- Additive. Nothing is deleted.
--
-- 1. briefs.skipped_at: a morning with nothing to say is marked done without sending,
--    so it is not retried every minute and the next morning knows where "since" starts.
-- 2. briefs.holdings: what the operator held at that morning, per asset: tokens in their
--    wallets, tokens staked, and the price used. The next morning compares against it and
--    says how much of the change was the price and how much was money moving.

ALTER TABLE briefs ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ;
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS holdings JSONB;
-- 3. question_groups.asked_item: the number a transfer had in the list Luca asked about
--    ("1 was a swap, 2 was revenue"), so an answer by number finds the right transfer.
ALTER TABLE question_groups ADD COLUMN IF NOT EXISTS asked_item INT;
