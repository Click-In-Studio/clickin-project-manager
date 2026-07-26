-- Replaces cue_list.default_edit_roles TEXT[] with a proper cue_list_role join table
-- that references production_role.id instead of storing role name strings.
-- Also migrates cue list creators into cue_list_permission so the creator check
-- is unified under the same override mechanism as personal grants/denies.

-- Step 1: create the new join table
CREATE TABLE IF NOT EXISTS cue_list_role (
  cue_list_id TEXT NOT NULL REFERENCES cue_list(id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL REFERENCES production_role(id) ON DELETE CASCADE,
  PRIMARY KEY (cue_list_id, role_id)
);
CREATE INDEX IF NOT EXISTS cue_list_role_list_idx ON cue_list_role(cue_list_id);

-- Step 2: seed production_role for productions that predate seedProductionRoles()
INSERT INTO production_role (id, production_id, name)
SELECT
  'pr' || substr(md5(p.id || '_' || rn.name), 1, 14),
  p.id,
  rn.name
FROM production p
CROSS JOIN (
  VALUES
    ('制作人'), ('编剧'), ('舞台监督'), ('助理舞台监督'),
    ('导演'), ('导演助理'), ('灯光设计'), ('灯光设计助理'),
    ('音响设计'), ('音响设计助理'), ('多媒体设计'), ('多媒体设计助理'),
    ('舞美设计'), ('舞美设计助理'), ('服化设计'), ('服化设计助理'),
    ('作曲'), ('作曲助理'), ('编曲'), ('音乐导演'), ('音乐导演助理'),
    ('技术导演'), ('访客')
) rn(name)
WHERE NOT EXISTS (
  SELECT 1 FROM production_role pr
  WHERE pr.production_id = p.id AND pr.name = rn.name
)
ON CONFLICT DO NOTHING;

-- Step 3: populate cue_list_role from existing default_edit_roles
INSERT INTO cue_list_role (cue_list_id, role_id)
SELECT cl.id, pr.id
FROM cue_list cl
JOIN production_role pr
  ON pr.production_id = cl.production_id
 AND pr.name = ANY(cl.default_edit_roles)
ON CONFLICT DO NOTHING;

-- Step 4: migrate creators into cue_list_permission (canEdit = true)
-- Creator's personal override now lives in the same table as all other overrides.
INSERT INTO cue_list_permission (cue_list_id, user_id, can_edit)
SELECT id, created_by, true
FROM cue_list
ON CONFLICT (cue_list_id, user_id) DO NOTHING;

-- Step 5: drop the now-redundant column
ALTER TABLE cue_list DROP COLUMN default_edit_roles;
