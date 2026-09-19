-- 权限REST化 批E PR-E3：个人视图域（dramaturgy_view / script_view）迁移。
--
-- 设计（总表批E + 持有者判据推论）：
--   个人视图 = 持有型资源，但所有权由 user_id 列上下文表达（"自己的视图自己管"，
--   路由已有 user_id=self 判定）——不发创建者行集（无分享面时行集是过度工程；
--   公开/分享功能实现时再补行集定式与 §0.9 条目）
--   公开视图 = publication 面（create_public 等 → publication@create/edit/delete，
--   功能未实现，节点串仅作模板资格预留）
--   现状考古：dramaturgy_view 6 键零路由消费（纯纸面）；RG script_view 零行
--
-- 自足守卫：幂等，可重复执行。

BEGIN;

-- ── 0. dramaturgy_view 词汇四动词（自确认路径 FK 前置）─────────────────────────
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('dramaturgy_view', 'view', 0), ('dramaturgy_view', 'create', 0),
  ('dramaturgy_view', 'edit', 0), ('dramaturgy_view', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ── 1. atomic 键活跃行 → RG 通配动词行 ───────────────────────────────────────
CREATE TEMP TABLE e3_map (key TEXT, rtype TEXT, sub TEXT, verb TEXT) ON COMMIT DROP;
INSERT INTO e3_map VALUES
  ('dramaturgy_view:create',           'dramaturgy_view', '*',           'create'),
  ('dramaturgy_view:create_public',    'dramaturgy_view', 'publication', 'create'),
  ('dramaturgy_view:delete_public',    'dramaturgy_view', 'publication', 'delete'),
  ('dramaturgy_view:overwrite_public', 'dramaturgy_view', 'publication', 'edit');
  -- delete / overwrite（own）退役：user_id 上下文承担，无行

INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT DISTINCT apg.production_id, apg.user_id, m.rtype, '*', m.sub, m.verb,
       apg.grant_source, apg.confirmed_by, apg.approval_id, apg.expires_at
FROM atomic_permission_grant apg
JOIN e3_map m ON m.key = apg.permission_key
WHERE NOT apg.is_revoked
  AND (apg.expires_at IS NULL OR apg.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM atomic_permission_grant WHERE permission_key LIKE 'dramaturgy_view:%';

-- ── 2. 三张 permission 表键 → 节点串 ─────────────────────────────────────────
CREATE TEMP TABLE e3_key_map (key TEXT, node_key TEXT) ON COMMIT DROP;
INSERT INTO e3_key_map
SELECT key, 'node:' || rtype || '/*'
       || CASE WHEN sub = '*' THEN '' ELSE '/' || sub END || '@' || verb
FROM e3_map;

INSERT INTO production_role_permission (role_id, permission_key)
SELECT DISTINCT prp.role_id, m.node_key
FROM production_role_permission prp JOIN e3_key_map m ON m.key = prp.permission_key
ON CONFLICT DO NOTHING;
DELETE FROM production_role_permission WHERE permission_key LIKE 'dramaturgy_view:%';

INSERT INTO production_member_permission (production_id, user_id, permission, granted)
SELECT DISTINCT pmp.production_id, pmp.user_id, m.node_key, pmp.granted
FROM production_member_permission pmp JOIN e3_key_map m ON m.key = pmp.permission
ON CONFLICT DO NOTHING;
DELETE FROM production_member_permission WHERE permission LIKE 'dramaturgy_view:%';

INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
SELECT DISTINCT pdp.production_id, pdp.dept_id, m.node_key
FROM production_dept_permission pdp JOIN e3_key_map m ON m.key = pdp.permission_key
ON CONFLICT (dept_id, permission_key) DO NOTHING;
DELETE FROM production_dept_permission WHERE permission_key LIKE 'dramaturgy_view:%';

UPDATE production_dept
SET permissions = (SELECT COALESCE(array_agg(p), '{}') FROM unnest(permissions) AS p
                   WHERE p NOT LIKE 'dramaturgy_view:%')
WHERE EXISTS (SELECT 1 FROM unnest(permissions) AS p WHERE p LIKE 'dramaturgy_view:%');

-- ── 3. RG script_view 级别拆解（持有型：manage 保留 grants）──────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'script_view', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
JOIN (VALUES
  ('manage', '*', 'edit'), ('manage', '*', 'delete'), ('manage', 'grants', 'edit')
) AS s(level, sub, verb) ON s.level = rg.permission_level
WHERE rg.resource_type = 'script_view' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM resource_grant WHERE resource_type = 'script_view' AND permission_level = 'manage';
DELETE FROM resource_permission_level
WHERE resource_type = 'script_view' AND permission_level = 'manage';

COMMIT;
