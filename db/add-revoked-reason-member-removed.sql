-- Add 'member_removed' to revoked_reason CHECK on both grant tables.
-- Required before removeProductionMember can revoke grants with this reason.
-- Pure DDL: drops the auto-named inline constraint and replaces it with a named one.

ALTER TABLE resource_grant
  DROP CONSTRAINT IF EXISTS resource_grant_revoked_reason_check;

ALTER TABLE resource_grant
  ADD CONSTRAINT resource_grant_revoked_reason_check
  CHECK (revoked_reason IN (
    'role_change', 'dept_change', 'dept_dissolved', 'poc_change', 'manual', 'member_removed'
  ));

ALTER TABLE atomic_permission_grant
  DROP CONSTRAINT IF EXISTS atomic_permission_grant_revoked_reason_check;

ALTER TABLE atomic_permission_grant
  ADD CONSTRAINT atomic_permission_grant_revoked_reason_check
  CHECK (revoked_reason IN (
    'role_change', 'dept_change', 'poc_change', 'manual', 'member_removed'
  ));
