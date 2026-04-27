-- Migration: allow POC to be set independently of membership
-- POC-only rows: is_member=false, is_poc=true (e.g. stage manager as actors-group POC)
-- Run: psql -d <db> -f migrate-dept-poc-independent.sql
-- Idempotent: safe to re-run.

ALTER TABLE event_department_member
  ADD COLUMN IF NOT EXISTS is_member BOOLEAN NOT NULL DEFAULT true;
