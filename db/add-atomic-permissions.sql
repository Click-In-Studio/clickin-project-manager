-- Atomic permission system: role definitions and permission assignments.
-- Run as postgres user after schema.sql.

-- Named role definitions per production.
-- Seeded from lib/permissions.ts ROLE_TEMPLATE_PERMISSIONS at production creation time.
-- 'owner' and 'producer' are not stored here; they short-circuit in code (#137).
CREATE TABLE IF NOT EXISTS production_role (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (production_id, name)
);

CREATE INDEX IF NOT EXISTS production_role_production_idx ON production_role(production_id);

-- Permission keys assigned to each role.
-- permission_key values match the Permission union type in lib/permissions.ts.
CREATE TABLE IF NOT EXISTS production_role_permission (
  role_id        TEXT NOT NULL REFERENCES production_role(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

CREATE INDEX IF NOT EXISTS production_role_permission_role_idx ON production_role_permission(role_id);

-- Cue list types that each role can operate on.
-- Replaces the ROLE_CUE_TYPES hardcoded constant in lib/cue-list-types.ts.
CREATE TABLE IF NOT EXISTS production_role_cue_type (
  role_id  TEXT NOT NULL REFERENCES production_role(id) ON DELETE CASCADE,
  cue_type TEXT NOT NULL,
  PRIMARY KEY (role_id, cue_type)
);

CREATE INDEX IF NOT EXISTS production_role_cue_type_role_idx ON production_role_cue_type(role_id);
