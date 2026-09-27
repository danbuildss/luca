-- Migration 024: label_proposals also hold changes the operator asked for in chat
--
-- Additive and safe to re-run. Existing rows are not changed.
--
-- A change the operator asks for ("0x4586… was revenue", "track wallet 0x…", "those 4
-- payments are expenses") is no longer confirmed with buttons. Luca asks in chat, in its
-- own fixed wording, and the change waits here until the operator answers:
--   kind 'changes': `actions` lists each change (tool, arguments, wording); the
--                   address, direction, label and event_ids of rule proposals are empty.
-- Keeping them in the same table as rule proposals (023) means "the one open question"
-- and "which one do you mean?" cover everything Luca is waiting on, and a restart no
-- longer loses a pending change.

ALTER TABLE label_proposals DROP CONSTRAINT IF EXISTS label_proposals_kind_check;
ALTER TABLE label_proposals ADD CONSTRAINT label_proposals_kind_check
  CHECK (kind IN ('apply_rule', 'send_back', 'changes'));

ALTER TABLE label_proposals ALTER COLUMN counterparty_address DROP NOT NULL;
ALTER TABLE label_proposals ALTER COLUMN direction DROP NOT NULL;
ALTER TABLE label_proposals ALTER COLUMN label DROP NOT NULL;
ALTER TABLE label_proposals ALTER COLUMN event_ids DROP NOT NULL;

ALTER TABLE label_proposals ADD COLUMN IF NOT EXISTS actions JSONB;
