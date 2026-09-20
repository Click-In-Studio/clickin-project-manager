-- Rebuild resource_grant_active_unique_idx with the correct predicate.
--
-- The original index was created without IF NOT EXISTS and may be missing on
-- some environments. This migration ensures the index exists with exactly
-- `WHERE is_revoked = false`.
--
-- Note: expires_at IS NOT included in the predicate because NOW() is not
-- IMMUTABLE and cannot appear in a PostgreSQL partial index expression.
-- Expired-but-not-revoked grants must be explicitly revoked (is_revoked = true)
-- by the application before issuing a replacement grant.
--
-- DROP + CREATE takes ACCESS EXCLUSIVE on resource_grant for the build duration.
-- Acceptable: resource_grant has very few rows in production today.

DROP INDEX IF EXISTS resource_grant_active_unique_idx;

CREATE UNIQUE INDEX resource_grant_active_unique_idx
  ON resource_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false;
