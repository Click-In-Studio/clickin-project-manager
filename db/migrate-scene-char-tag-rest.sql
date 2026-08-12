-- 权限REST化 批E PR-E1：scene / character / tag_group / tag_option 域迁移。
--
-- 设计（总表批E + §0.10 持有者判据，2026-08-12 用户定谳）：
--   结构型资源（无持有者，主人即 production）：不设 <id>/grants 节点、
--   创建不触发创建者行集/person 归属（编剧建 scene，许可修改是制作人的工作）、
--   授权行可存在但发行权归治理面（批F）
--   三态目录：meta@view=目录、内容 sub@view=详情、无行=不可见；
--   字段写挂 meta 下（meta/name 等静态复合 sub，hasGrant 精确匹配+'*' 兜底）
--   tag_option = tag_group 树的 options 子集合
--
-- 自足守卫：幂等；依赖 add-scene-char-tag-verbs.sql（此处镜像守卫）。

BEGIN;

-- ── 0. 跨文件依赖守卫 ─────────────────────────────────────────────────────────
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('character', 'view', 0), ('character', 'create', 0), ('character', 'edit', 0), ('character', 'delete', 0),
  ('tag_group', 'view', 0), ('tag_group', 'create', 0), ('tag_group', 'edit', 0), ('tag_group', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ── 1. atomic 键活跃行 → RG 通配动词行 ───────────────────────────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT DISTINCT apg.production_id, apg.user_id, m.rtype, '*', m.sub, m.verb,
       apg.grant_source, apg.confirmed_by, apg.approval_id, apg.expires_at
FROM atomic_permission_grant apg
JOIN (VALUES
  -- scene（view 拆三态：meta + 四内容面）
  ('scene:create',                 'scene', '*',                    'create'),
  ('scene:delete',                 'scene', '*',                    'delete'),
  ('scene:view',                   'scene', 'meta',                 'view'),
  ('scene:view',                   'scene', 'synopsis',             'view'),
  ('scene:view',                   'scene', 'action_line',          'view'),
  ('scene:view',                   'scene', 'music',                'view'),
  ('scene:view',                   'scene', 'stage_notes',          'view'),
  -- scene:rename 是历史万能写代理（结构域全写权，未标注 bundle）：按实际 implication 拆
  ('scene:rename',                 'scene', 'meta/name',            'edit'),
  ('scene:rename',                 'scene', '*',                    'create'),
  ('scene:rename',                 'scene', '*',                    'delete'),
  ('scene:rename',                 'scene', '*',                    'edit'),
  ('scene:rename',                 'character', '*',                'create'),
  ('scene:rename',                 'character', '*',                'delete'),
  ('scene:rename',                 'character', '*',                'edit'),
  ('scene:rename',                 'tag_group', '*',                'create'),
  ('scene:rename',                 'tag_group', '*',                'delete'),
  ('scene:rename',                 'tag_group', '*',                'edit'),
  ('scene:rename',                 'tag_group', 'options',          'create'),
  ('scene:rename',                 'tag_group', 'options',          'delete'),
  ('scene:renumber',               'scene', 'meta/number',          'edit'),
  ('scene:change_type',            'scene', 'meta/type',            'edit'),
  ('scene:edit_expected_duration', 'scene', 'meta/expected_duration', 'edit'),
  ('scene:edit_synopsis',          'scene', 'synopsis',             'edit'),
  ('scene:edit_action_line',       'scene', 'action_line',          'edit'),
  ('scene:edit_music',             'scene', 'music',                'edit'),
  ('scene:edit_stage_notes',       'scene', 'stage_notes',          'edit'),
  ('scene:mount',                  'scene', 'mounts',               'create'),
  -- character（view 拆三态：meta + 四内容面）
  ('character:create',             'character', '*',           'create'),
  ('character:delete',             'character', '*',           'delete'),
  ('character:view',               'character', 'meta',        'view'),
  ('character:view',               'character', 'gender',      'view'),
  ('character:view',               'character', 'biography',   'view'),
  ('character:view',               'character', 'role_type',   'view'),
  ('character:view',               'character', 'members',     'view'),
  ('character:rename',             'character', 'meta/name',   'edit'),
  ('character:change_type',        'character', 'meta/type',   'edit'),
  ('character:set_members',        'character', 'members',     'edit'),
  ('character:edit_gender',        'character', 'gender',      'edit'),
  ('character:edit_biography',     'character', 'biography',   'edit'),
  ('character:edit_role_type',     'character', 'role_type',   'edit'),
  -- tag_group / tag_option（options 子集合）
  ('tag_group:create',             'tag_group', '*',                'create'),
  ('tag_group:delete',             'tag_group', '*',                'delete'),
  ('tag_group:rename',             'tag_group', 'meta/name',        'edit'),
  ('tag_group:reorder',            'tag_group', 'meta/position',    'edit'),
  ('tag_group:edit_range_config',  'tag_group', 'range_config',     'edit'),
  ('tag_group:set_default_option', 'tag_group', 'default_option',   'edit'),
  ('tag_group:set_lyric_split',    'tag_group', 'lyric_split',      'edit'),
  ('tag_option:create',            'tag_group', 'options',          'create'),
  ('tag_option:delete',            'tag_group', 'options',          'delete'),
  ('tag_option:rename',            'tag_group', 'options/name',     'edit'),
  ('tag_option:edit_color',        'tag_group', 'options/color',    'edit'),
  ('tag_option:reorder',           'tag_group', 'options/position', 'edit')
) AS m(key, rtype, sub, verb) ON m.key = apg.permission_key
WHERE NOT apg.is_revoked
  AND (apg.expires_at IS NULL OR apg.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM atomic_permission_grant
WHERE permission_key LIKE 'scene:%' OR permission_key LIKE 'character:%'
   OR permission_key LIKE 'tag_group:%' OR permission_key LIKE 'tag_option:%';

-- ── 2. 三张 permission 表键 → 节点串 ─────────────────────────────────────────
-- （映射同上；节点串形态 node:<type>/*[/<sub>]@<verb>）
CREATE TEMP TABLE e1_key_map (key TEXT, node_key TEXT) ON COMMIT DROP;
INSERT INTO e1_key_map VALUES
  ('scene:create',                 'node:scene/*@create'),
  ('scene:delete',                 'node:scene/*@delete'),
  ('scene:view',                   'node:scene/*/meta@view'),
  ('scene:view',                   'node:scene/*/synopsis@view'),
  ('scene:view',                   'node:scene/*/action_line@view'),
  ('scene:view',                   'node:scene/*/music@view'),
  ('scene:view',                   'node:scene/*/stage_notes@view'),
  ('scene:rename',                 'node:scene/*/meta/name@edit'),
  ('scene:rename',                 'node:scene/*@create'),
  ('scene:rename',                 'node:scene/*@delete'),
  ('scene:rename',                 'node:scene/*@edit'),
  ('scene:rename',                 'node:character/*@create'),
  ('scene:rename',                 'node:character/*@delete'),
  ('scene:rename',                 'node:character/*@edit'),
  ('scene:rename',                 'node:tag_group/*@create'),
  ('scene:rename',                 'node:tag_group/*@delete'),
  ('scene:rename',                 'node:tag_group/*@edit'),
  ('scene:rename',                 'node:tag_group/*/options@create'),
  ('scene:rename',                 'node:tag_group/*/options@delete'),
  ('scene:renumber',               'node:scene/*/meta/number@edit'),
  ('scene:change_type',            'node:scene/*/meta/type@edit'),
  ('scene:edit_expected_duration', 'node:scene/*/meta/expected_duration@edit'),
  ('scene:edit_synopsis',          'node:scene/*/synopsis@edit'),
  ('scene:edit_action_line',       'node:scene/*/action_line@edit'),
  ('scene:edit_music',             'node:scene/*/music@edit'),
  ('scene:edit_stage_notes',       'node:scene/*/stage_notes@edit'),
  ('scene:mount',                  'node:scene/*/mounts@create'),
  ('character:create',             'node:character/*@create'),
  ('character:delete',             'node:character/*@delete'),
  ('character:view',               'node:character/*/meta@view'),
  ('character:view',               'node:character/*/gender@view'),
  ('character:view',               'node:character/*/biography@view'),
  ('character:view',               'node:character/*/role_type@view'),
  ('character:view',               'node:character/*/members@view'),
  ('character:rename',             'node:character/*/meta/name@edit'),
  ('character:change_type',        'node:character/*/meta/type@edit'),
  ('character:set_members',        'node:character/*/members@edit'),
  ('character:edit_gender',        'node:character/*/gender@edit'),
  ('character:edit_biography',     'node:character/*/biography@edit'),
  ('character:edit_role_type',     'node:character/*/role_type@edit'),
  ('tag_group:create',             'node:tag_group/*@create'),
  ('tag_group:delete',             'node:tag_group/*@delete'),
  ('tag_group:rename',             'node:tag_group/*/meta/name@edit'),
  ('tag_group:reorder',            'node:tag_group/*/meta/position@edit'),
  ('tag_group:edit_range_config',  'node:tag_group/*/range_config@edit'),
  ('tag_group:set_default_option', 'node:tag_group/*/default_option@edit'),
  ('tag_group:set_lyric_split',    'node:tag_group/*/lyric_split@edit'),
  ('tag_option:create',            'node:tag_group/*/options@create'),
  ('tag_option:delete',            'node:tag_group/*/options@delete'),
  ('tag_option:rename',            'node:tag_group/*/options/name@edit'),
  ('tag_option:edit_color',        'node:tag_group/*/options/color@edit'),
  ('tag_option:reorder',           'node:tag_group/*/options/position@edit');

INSERT INTO production_role_permission (role_id, permission_key)
SELECT DISTINCT prp.role_id, m.node_key
FROM production_role_permission prp JOIN e1_key_map m ON m.key = prp.permission_key
ON CONFLICT DO NOTHING;

DELETE FROM production_role_permission
WHERE permission_key LIKE 'scene:%' OR permission_key LIKE 'character:%'
   OR permission_key LIKE 'tag_group:%' OR permission_key LIKE 'tag_option:%';

INSERT INTO production_member_permission (production_id, user_id, permission, granted)
SELECT DISTINCT pmp.production_id, pmp.user_id, m.node_key, pmp.granted
FROM production_member_permission pmp JOIN e1_key_map m ON m.key = pmp.permission
ON CONFLICT DO NOTHING;

DELETE FROM production_member_permission
WHERE permission LIKE 'scene:%' OR permission LIKE 'character:%'
   OR permission LIKE 'tag_group:%' OR permission LIKE 'tag_option:%';

INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
SELECT DISTINCT pdp.production_id, pdp.dept_id, m.node_key
FROM production_dept_permission pdp JOIN e1_key_map m ON m.key = pdp.permission_key
ON CONFLICT (dept_id, permission_key) DO NOTHING;

DELETE FROM production_dept_permission
WHERE permission_key LIKE 'scene:%' OR permission_key LIKE 'character:%'
   OR permission_key LIKE 'tag_group:%' OR permission_key LIKE 'tag_option:%';

UPDATE production_dept
SET permissions = (SELECT COALESCE(array_agg(p), '{}') FROM unnest(permissions) AS p
                   WHERE p NOT LIKE 'scene:%' AND p NOT LIKE 'character:%'
                     AND p NOT LIKE 'tag_group:%' AND p NOT LIKE 'tag_option:%')
WHERE EXISTS (SELECT 1 FROM unnest(permissions) AS p
              WHERE p LIKE 'scene:%' OR p LIKE 'character:%'
                 OR p LIKE 'tag_group:%' OR p LIKE 'tag_option:%');

-- ── 3. RG scene 级别行拆解（结构型：manage 无 grants，§0.10 持有者判据）──────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'scene', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
JOIN (VALUES
  ('view',  'meta',        'view'), ('view', 'synopsis', 'view'), ('view', 'action_line', 'view'),
  ('view',  'music',       'view'), ('view', 'stage_notes', 'view'),
  ('mount', 'mounts',      'create'),
  ('manage', '*', 'edit'), ('manage', '*', 'delete'), ('manage', 'mounts', 'create'),
  ('manage', 'meta', 'view'), ('manage', 'synopsis', 'view'), ('manage', 'action_line', 'view'),
  ('manage', 'music', 'view'), ('manage', 'stage_notes', 'view')
) AS s(level, sub, verb) ON s.level = rg.permission_level
WHERE rg.resource_type = 'scene' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- 老 ('*','view') 行保留为合法 '*'@view 树行（批C report 先例）；edit 沿用；
-- mount/manage 级别行拆解后删除（词汇 FK 要求先删行再删词汇）
DELETE FROM resource_grant
WHERE resource_type = 'scene' AND permission_level IN ('mount', 'manage');

DELETE FROM resource_permission_level
WHERE resource_type = 'scene' AND permission_level IN ('mount', 'manage');

-- ── 4. 全局模板种子（MEMBER_BASE 保真：scene:view / character:view 三态默认）──
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:scene/*/meta@view'),
  ('*', 'node:scene/*/synopsis@view'),
  ('*', 'node:scene/*/action_line@view'),
  ('*', 'node:scene/*/music@view'),
  ('*', 'node:scene/*/stage_notes@view'),
  ('*', 'node:character/*/meta@view'),
  ('*', 'node:character/*/gender@view'),
  ('*', 'node:character/*/biography@view'),
  ('*', 'node:character/*/role_type@view'),
  ('*', 'node:character/*/members@view')
ON CONFLICT DO NOTHING;

COMMIT;
