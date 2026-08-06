-- Fix resource_grant_active_unique_idx: add expires_at predicate so that
-- expired-but-not-revoked rows are excluded from the uniqueness check.
--
-- Without this, a new grant sharing the same (production, user, resource, level)
-- key as an expired row would be silently blocked by ON CONFLICT DO NOTHING,
-- creating a permission black hole with no error surface.
--
-- Safe to run on a live DB: DROP + CREATE INDEX is not a data migration and
-- resource_grant has no expired rows today (all expires_at = NULL).

DROP INDEX IF EXISTS resource_grant_active_unique_idx;

CREATE UNIQUE INDEX resource_grant_active_unique_idx
  ON resource_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false AND (expires_at IS NULL OR expires_at > NOW());
