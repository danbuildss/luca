-- Migration 022: audit_runs.base_run_id
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- Production created audit_runs from the first version of migration 021 (with a
-- `signature` column, without `base_run_id`). 021 was later changed in place, so
-- re-applying it was a no-op (CREATE TABLE IF NOT EXISTS). This adds the missing column.
-- The old `signature` column is unused and left in place.
--
-- base_run_id: set when a check verified only the blocks after an earlier check whose
-- result still held; this run's result then covers both.

ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS base_run_id UUID REFERENCES audit_runs(id) ON DELETE SET NULL;
