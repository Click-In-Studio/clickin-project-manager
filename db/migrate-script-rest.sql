-- 权限REST化 批E PR-E2：script 单例 + rehearsal_mark + comments + imports 迁移。
--
-- 设计（总表批E + 2026-08-12 用户定谳）：
--   script 单例资源：id 恒 '*'，无目录三态（script:view → blocks@view）
--   **imports 保留段**（第四段）：本质普通节点，特殊性=一次动作批量行使
--   create/edit/delete（导入重建海量 blocks，安全隐患大）→ '*' 通配不覆盖、必须显式
--   bundle 键按现 implication 拆行集（考古结论：annotate ⊂ edit = manage，
--   MANAGE_DOMAIN 与 EDIT_DOMAIN 相等，manage 无额外能力）
--   结构型资源（§0.10 持有者判据）：无 grants 段、无创建者行集
--
-- 自足守卫：幂等；依赖 add-script-dramaturgy-verbs.sql（此处镜像守卫）。

BEGIN;

-- ── 0. 跨文件依赖守卫 ─────────────────────────────────────────────────────────
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('script',     'view', 0), ('script',     'create', 0), ('script',     'edit', 0), ('script',     'delete', 0),
  ('dramaturgy', 'view', 0), ('dramaturgy', 'create', 0), ('dramaturgy', 'edit', 0), ('dramaturgy', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ── 1. atomic 键活跃行 → RG 通配动词行 ───────────────────────────────────────
CREATE TEMP TABLE e2_rg_map (key TEXT, rtype TEXT, sub TEXT, verb TEXT) ON COMMIT DROP;
INSERT INTO e2_rg_map VALUES
  ('script:import',             'script', 'imports',                  'create'),
  ('dramaturgy:import',         'dramaturgy', 'imports',              'create'),
  ('script:view',               'script', 'blocks',                   'view'),
  ('script:comment',            'script', 'comments',                 'create'),
  ('script:edit_comment_any',   'script', 'comments',                 'edit'),
  ('script:delete_comment_any', 'script', 'comments',                 'delete'),
  ('script:create_block',       'script', 'blocks',                   'create'),
  ('script:delete_block',       'script', 'blocks',                   'delete'),
  ('script:edit_block',         'script', 'blocks',                   'edit'),
  ('script:set_character',      'script', 'blocks/character',         'edit'),
  ('script:set_type',           'script', 'blocks/type',              'edit'),
  ('script:set_tag',            'script', 'blocks/tags',              'edit'),
  ('script:reorder',            'script', 'blocks/position',          'edit'),
  ('script:mount',              'script', 'mounts',                   'create'),
  ('rehearsal_mark:create',     'script', 'rehearsal_marks',          'create'),
  ('rehearsal_mark:edit',       'script', 'rehearsal_marks',          'edit'),
  ('rehearsal_mark:delete',     'script', 'rehearsal_marks',          'delete'),
  ('rehearsal_mark:move',       'script', 'rehearsal_marks/position', 'edit'),
  -- bundle：script:annotate ⊂ script:edit = script:manage（现 implication 保真）
  ('script:annotate', 'script', 'rehearsal_marks',          'create'),
  ('script:annotate', 'script', 'rehearsal_marks',          'edit'),
  ('script:annotate', 'script', 'rehearsal_marks',          'delete'),
  ('script:annotate', 'script', 'rehearsal_marks/position', 'edit'),
  ('script:edit',     'script', 'rehearsal_marks',          'create'),
  ('script:edit',     'script', 'rehearsal_marks',          'edit'),
  ('script:edit',     'script', 'rehearsal_marks',          'delete'),
  ('script:edit',     'script', 'rehearsal_marks/position', 'edit'),
  ('script:edit',     'script', 'blocks',                   'create'),
  ('script:edit',     'script', 'blocks',                   'delete'),
  ('script:edit',     'script', 'blocks',                   'edit'),
  ('script:edit',     'script', 'blocks/character',         'edit'),
  ('script:edit',     'script', 'blocks/type',              'edit'),
  ('script:edit',     'script', 'blocks/tags',              'edit'),
  ('script:edit',     'script', 'blocks/position',          'edit'),
  ('script:edit',     'script', 'mounts',                   'create'),
  ('script:manage',   'script', 'rehearsal_marks',          'create'),
  ('script:manage',   'script', 'rehearsal_marks',          'edit'),
  ('script:manage',   'script', 'rehearsal_marks',          'delete'),
  ('script:manage',   'script', 'rehearsal_marks/position', 'edit'),
  ('script:manage',   'script', 'blocks',                   'create'),
  ('script:manage',   'script', 'blocks',                   'delete'),
  ('script:manage',   'script', 'blocks',                   'edit'),
  ('script:manage',   'script', 'blocks/character',         'edit'),
  ('script:manage',   'script', 'blocks/type',              'edit'),
  ('script:manage',   'script', 'blocks/tags',              'edit'),
  ('script:manage',   'script', 'blocks/position',          'edit'),
  ('script:manage',   'script', 'mounts',                   'create');

INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT DISTINCT apg.production_id, apg.user_id, m.rtype, '*', m.sub, m.verb,
       apg.grant_source, apg.confirmed_by, apg.approval_id, apg.expires_at
FROM atomic_permission_grant apg
JOIN e2_rg_map m ON m.key = apg.permission_key
WHERE NOT apg.is_revoked
  AND (apg.expires_at IS NULL OR apg.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM atomic_permission_grant
WHERE permission_key LIKE 'script:%' OR permission_key LIKE 'rehearsal_mark:%'
   OR permission_key = 'dramaturgy:import';

-- ── 2. 三张 permission 表键 → 节点串 ─────────────────────────────────────────
CREATE TEMP TABLE e2_key_map (key TEXT, node_key TEXT) ON COMMIT DROP;
INSERT INTO e2_key_map
SELECT key, 'node:' || rtype || '/*'
       || CASE WHEN sub = '*' THEN '' ELSE '/' || sub END || '@' || verb
FROM e2_rg_map;

INSERT INTO production_role_permission (role_id, permission_key)
SELECT DISTINCT prp.role_id, m.node_key
FROM production_role_permission prp JOIN e2_key_map m ON m.key = prp.permission_key
ON CONFLICT DO NOTHING;

DELETE FROM production_role_permission
WHERE permission_key LIKE 'script:%' OR permission_key LIKE 'rehearsal_mark:%'
   OR permission_key = 'dramaturgy:import';

INSERT INTO production_member_permission (production_id, user_id, permission, granted)
SELECT DISTINCT pmp.production_id, pmp.user_id, m.node_key, pmp.granted
FROM production_member_permission pmp JOIN e2_key_map m ON m.key = pmp.permission
ON CONFLICT DO NOTHING;

DELETE FROM production_member_permission
WHERE permission LIKE 'script:%' OR permission LIKE 'rehearsal_mark:%'
   OR permission = 'dramaturgy:import';

INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
SELECT DISTINCT pdp.production_id, pdp.dept_id, m.node_key
FROM production_dept_permission pdp JOIN e2_key_map m ON m.key = pdp.permission_key
ON CONFLICT (dept_id, permission_key) DO NOTHING;

DELETE FROM production_dept_permission
WHERE permission_key LIKE 'script:%' OR permission_key LIKE 'rehearsal_mark:%'
   OR permission_key = 'dramaturgy:import';

UPDATE production_dept
SET permissions = (SELECT COALESCE(array_agg(p), '{}') FROM unnest(permissions) AS p
                   WHERE p NOT LIKE 'script:%' AND p NOT LIKE 'rehearsal_mark:%'
                     AND p != 'dramaturgy:import')
WHERE EXISTS (SELECT 1 FROM unnest(permissions) AS p
              WHERE p LIKE 'script:%' OR p LIKE 'rehearsal_mark:%' OR p = 'dramaturgy:import');

-- ── 3. 全局模板种子（MEMBER_BASE 保真：script:view / script:comment）─────────
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:script/*/blocks@view'),
  ('*', 'node:script/*/comments@create')
ON CONFLICT DO NOTHING;

COMMIT;
