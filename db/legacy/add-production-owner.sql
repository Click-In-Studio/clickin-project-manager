-- Add owner_id to production table.
--
-- The production owner has ROOT-level permissions (delete / transfer_owner /
-- restore_checkpoint) and implicit SENSITIVE_ADMIN permissions without needing
-- an explicit grant. This field was planned in the PRD (#137) but was omitted
-- from the Phase 2 implementation.
--
-- Nullable so that:
--   1. Existing productions on a fresh DB (CI) do not require seed data.
--   2. Historical productions can be assigned owners post-deploy without a
--      single-transaction backfill blocking the table.
-- A NULL owner_id means no owner is currently designated — ROOT and
-- SENSITIVE_ADMIN permissions fall back to isAdmin only.

ALTER TABLE production
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES app_user(id);
