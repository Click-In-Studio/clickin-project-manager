-- Add gender, biography, role_type to character_version; strip data columns from character.
-- character becomes a pure identity anchor (id, production_id), mirroring the scene refactor.

ALTER TABLE character_version
  ADD COLUMN IF NOT EXISTS gender    TEXT,
  ADD COLUMN IF NOT EXISTS biography TEXT,
  ADD COLUMN IF NOT EXISTS role_type TEXT;

UPDATE character_version cv
SET gender    = c.gender,
    biography = c.biography,
    role_type = c.role_type
FROM character c
WHERE cv.character_id = c.id;

ALTER TABLE character
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS sort_order,
  DROP COLUMN IF EXISTS is_aggregate,
  DROP COLUMN IF EXISTS gender,
  DROP COLUMN IF EXISTS biography,
  DROP COLUMN IF EXISTS role_type;
