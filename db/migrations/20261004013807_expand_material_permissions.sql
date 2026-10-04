-- migrate:up

-- #822：把旧物料 CRUD 收敛为定义、日常事实与治理三层。
-- 四类来源各自在原层级展开；不枚举成员，不把结构关系物化成 grant。
WITH mapping(old_verb, new_suffix) AS (VALUES
  ('create', 'definition@create'),
  ('edit', 'definition@edit'),
  ('delete', 'definition@delete'),
  ('edit', 'receipts@edit'),
  ('edit', 'circulation/checkouts@edit'),
  ('edit', 'circulation/returns@edit'),
  ('edit', 'maintenance@edit'),
  ('edit', 'sources@edit'),
  ('edit', 'stock/adjustments@edit'),
  ('edit', 'stock/exits@edit'),
  ('edit', 'identifiers@edit')
), source AS (
  SELECT prp.role_id, prp.permission_key,
         COALESCE(substring(prp.permission_key FROM '^node:material/([^/@]+)'), '*') AS resource_id,
         substring(prp.permission_key FROM '@(create|edit|delete|\*)$') AS old_verb
    FROM production_role_permission prp
   WHERE prp.permission_key ~ '^node:material/[^/@]+@(create|edit|delete|\*)$'
      OR prp.permission_key ~ '^node:\*/\*@(create|edit|delete|\*)$'
)
INSERT INTO production_role_permission (role_id, permission_key)
SELECT DISTINCT s.role_id, 'node:material/' || s.resource_id || '/' || m.new_suffix
  FROM source s JOIN mapping m ON s.old_verb IN (m.old_verb, '*')
ON CONFLICT DO NOTHING;

WITH mapping(old_verb, new_suffix) AS (VALUES
  ('create', 'definition@create'), ('edit', 'definition@edit'), ('delete', 'definition@delete'),
  ('edit', 'receipts@edit'), ('edit', 'circulation/checkouts@edit'),
  ('edit', 'circulation/returns@edit'), ('edit', 'maintenance@edit'),
  ('edit', 'sources@edit'), ('edit', 'stock/adjustments@edit'),
  ('edit', 'stock/exits@edit'), ('edit', 'identifiers@edit')
), source AS (
  SELECT pdp.production_id, pdp.dept_id, pdp.source, pdp.permission_key,
         COALESCE(substring(pdp.permission_key FROM '^node:material/([^/@]+)'), '*') AS resource_id,
         substring(pdp.permission_key FROM '@(create|edit|delete|\*)$') AS old_verb
    FROM production_dept_permission pdp
   WHERE pdp.permission_key ~ '^node:material/[^/@]+@(create|edit|delete|\*)$'
      OR pdp.permission_key ~ '^node:\*/\*@(create|edit|delete|\*)$'
)
INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
SELECT DISTINCT s.production_id, s.dept_id,
       'node:material/' || s.resource_id || '/' || m.new_suffix, s.source
  FROM source s JOIN mapping m ON s.old_verb IN (m.old_verb, '*')
ON CONFLICT DO NOTHING;

WITH mapping(old_verb, new_suffix) AS (VALUES
  ('create', 'definition@create'), ('edit', 'definition@edit'), ('delete', 'definition@delete'),
  ('edit', 'receipts@edit'), ('edit', 'circulation/checkouts@edit'),
  ('edit', 'circulation/returns@edit'), ('edit', 'maintenance@edit'),
  ('edit', 'sources@edit'), ('edit', 'stock/adjustments@edit'),
  ('edit', 'stock/exits@edit'), ('edit', 'identifiers@edit')
), source AS (
  SELECT pmp.production_id, pmp.user_id, pmp.granted, pmp.permission,
         COALESCE(substring(pmp.permission FROM '^node:material/([^/@]+)'), '*') AS resource_id,
         substring(pmp.permission FROM '@(create|edit|delete|\*)$') AS old_verb
    FROM production_member_permission pmp
   WHERE pmp.permission ~ '^node:material/[^/@]+@(create|edit|delete|\*)$'
      OR pmp.permission ~ '^node:\*/\*@(create|edit|delete|\*)$'
)
INSERT INTO production_member_permission (production_id, user_id, permission, granted)
SELECT DISTINCT s.production_id, s.user_id,
       'node:material/' || s.resource_id || '/' || m.new_suffix, s.granted
  FROM source s JOIN mapping m ON s.old_verb IN (m.old_verb, '*')
ON CONFLICT DO NOTHING;

WITH mapping(old_level, new_sub, new_level) AS (VALUES
  ('create', 'definition', 'create'), ('edit', 'definition', 'edit'),
  ('delete', 'definition', 'delete'), ('edit', 'receipts', 'edit'),
  ('edit', 'circulation/checkouts', 'edit'), ('edit', 'circulation/returns', 'edit'),
  ('edit', 'maintenance', 'edit'), ('edit', 'sources', 'edit'),
  ('edit', 'stock/adjustments', 'edit'), ('edit', 'stock/exits', 'edit'),
  ('edit', 'identifiers', 'edit')
)
INSERT INTO production_member_grant
  (production_id, user_id, resource_type, resource_id, resource_sub, permission_level,
   grant_source, confirmed_by, approval_id, expires_at, created_at)
SELECT g.production_id, g.user_id, g.resource_type, g.resource_id, m.new_sub, m.new_level,
       g.grant_source, g.confirmed_by, g.approval_id, g.expires_at, g.created_at
  FROM production_member_grant g
  JOIN mapping m ON m.old_level=g.permission_level
 WHERE g.resource_type='material' AND g.resource_sub='*' AND NOT g.is_revoked
   AND (g.expires_at IS NULL OR g.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked=false DO NOTHING;

UPDATE production_member_grant
   SET is_revoked=true, revoked_reason='manual'
 WHERE resource_type='material' AND resource_sub='*'
   AND permission_level IN ('create','edit','delete') AND NOT is_revoked;

-- 旧物料专用 CRUD 区间退出；泛型 node:* 区间仍服务其他资源，且已显式补齐物料治理键。
DELETE FROM production_role_permission
 WHERE permission_key ~ '^node:material/[^/@]+@(create|edit|delete|\*)$';
DELETE FROM production_dept_permission
 WHERE permission_key ~ '^node:material/[^/@]+@(create|edit|delete|\*)$';
DELETE FROM production_member_permission
 WHERE permission ~ '^node:material/[^/@]+@(create|edit|delete|\*)$';

-- migrate:down

DO $$ BEGIN
  RAISE EXCEPTION 'irreversible: material permission sources were expanded and legacy rows retired';
END $$;
