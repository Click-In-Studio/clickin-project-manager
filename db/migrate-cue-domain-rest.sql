-- 权限REST化 批A：cue 域存量迁移（总表批A + §0.6/§0.7）。
--
-- 前置：add-rest-verbs.sql（动词词汇行）、add-grant-template.sql（模板表）已应用。
--
-- 内容：
--   1. resource_grant 旧级别行拆解为动词行集（edit 补行集；manage/mount 拆解后删除）
--   2. atomic_permission_grant 的 cue 域激活行 → resource_grant 通配动词行，随后删除
--   3. production_role_permission 的 cue 域键 → 演出级 grant_template 行，随后删除
--      （基础写键 cue_list:delete/rename 等无转换——语义由创建者自动行集承担，§0.6）
--   4. 词汇表删除 cue_list 的 mount/manage 级别
--
-- 幂等：全部 INSERT 带 ON CONFLICT DO NOTHING；DELETE 目标不存在时无操作。

BEGIN;

-- ── 1a. edit 行补行集（原 ('*','edit') 行本身是合法树行，保留） ─────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'cue_list', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
CROSS JOIN (VALUES ('*', 'view'), ('cues', 'create'), ('cues', 'delete')) AS s(sub, verb)
WHERE rg.resource_type = 'cue_list'
  AND rg.permission_level = 'edit'
  AND rg.resource_sub = '*'
  AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- ── 1b. manage 行拆解为完整行集，随后删除（含已撤销行，为词汇行 FK 清障） ────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'cue_list', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
CROSS JOIN (VALUES ('*', 'view'), ('*', 'edit'), ('cues', 'create'), ('cues', 'delete'),
                   ('*', 'delete'), ('grants', 'edit')) AS s(sub, verb)
WHERE rg.resource_type = 'cue_list'
  AND rg.permission_level = 'manage'
  AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM resource_grant
WHERE resource_type = 'cue_list' AND permission_level = 'manage';

-- ── 1c. mount 行 → mounts/create，随后删除 ────────────────────────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'cue_list', rg.resource_id, 'mounts', 'create',
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
WHERE rg.resource_type = 'cue_list'
  AND rg.permission_level = 'mount'
  AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM resource_grant
WHERE resource_type = 'cue_list' AND permission_level = 'mount';

-- ── 2. atomic_permission_grant cue 域激活行 → 通配动词行，随后删除 ──────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT apg.production_id, apg.user_id, 'cue_list', '*', m.sub, m.verb,
       apg.grant_source, apg.confirmed_by, apg.approval_id, apg.expires_at
FROM atomic_permission_grant apg
JOIN (VALUES
  ('cue_list:view',                 'meta',             'view'),
  ('cue_list:view',                 'cues',             'view'),
  ('cue:view',                      'cues',             'view'),
  ('cue:comment',                   'cues/comments',    'create'),
  ('cue_list:create',               '*',                'create'),
  ('cue_list:create_any',           '*',                'create'),
  ('cue_list:delete_any',           '*',                'delete'),
  ('cue_list:rename_any',           'meta/name',        'edit'),
  ('cue_list:reorder_any',          'meta/position',    'edit'),
  ('cue_list:edit_abbr_any',        'meta/abbr',        'edit'),
  ('cue_list:edit_description_any', 'meta/description', 'edit'),
  ('cue_list:manage_permissions_any', 'grants',         'edit'),
  ('cue:create_any',                'cues',             'create'),
  ('cue:delete_any',                'cues',             'delete'),
  ('cue:renumber_any',              'cues/numbering',   'edit'),
  ('cue:rename_any',                'cues/name',        'edit'),
  ('cue:edit_description_any',      'cues/description', 'edit'),
  ('cue:move_any',                  'cues/position',    'edit'),
  ('cue:mount_any',                 'cues/mounts',      'create'),
  ('cue:edit_comment_any',          'cues/comments',    'edit'),
  ('cue:delete_comment_any',        'cues/comments',    'delete')
) AS m(key, sub, verb) ON m.key = apg.permission_key
WHERE NOT apg.is_revoked
  AND (apg.expires_at IS NULL OR apg.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM atomic_permission_grant
WHERE permission_key LIKE 'cue_list:%' OR permission_key LIKE 'cue:%';

-- ── 3. production_role_permission cue 域键 → 演出级模板行，随后删除 ─────────────
-- 覆盖语义注意：#158 起所有演出角色都有 DB 行，因此本转换给所有存量角色写演出级
-- 模板行（覆盖全局种子）；新演出的角色无演出级行 → 回落全局模板。
INSERT INTO grant_template
  (production_id, holder_type, holder_id, resource_type, resource_id, resource_sub, verb)
SELECT DISTINCT pr.production_id, 'role', prp.role_id, 'cue_list', '*', m.sub, m.verb
FROM production_role_permission prp
JOIN production_role pr ON pr.id = prp.role_id
JOIN (VALUES
  ('cue_list:view',                 'meta',             'view'),
  ('cue_list:view',                 'cues',             'view'),
  ('cue:view',                      'cues',             'view'),
  ('cue:comment',                   'cues/comments',    'create'),
  ('cue_list:create',               '*',                'create'),
  ('cue_list:create_any',           '*',                'create'),
  ('cue_list:delete_any',           '*',                'delete'),
  ('cue_list:rename_any',           'meta/name',        'edit'),
  ('cue_list:reorder_any',          'meta/position',    'edit'),
  ('cue_list:edit_abbr_any',        'meta/abbr',        'edit'),
  ('cue_list:edit_description_any', 'meta/description', 'edit'),
  ('cue_list:manage_permissions_any', 'grants',         'edit'),
  ('cue:create_any',                'cues',             'create'),
  ('cue:delete_any',                'cues',             'delete'),
  ('cue:renumber_any',              'cues/numbering',   'edit'),
  ('cue:rename_any',                'cues/name',        'edit'),
  ('cue:edit_description_any',      'cues/description', 'edit'),
  ('cue:move_any',                  'cues/position',    'edit'),
  ('cue:mount_any',                 'cues/mounts',      'create'),
  ('cue:edit_comment_any',          'cues/comments',    'edit'),
  ('cue:delete_comment_any',        'cues/comments',    'delete')
) AS m(key, sub, verb) ON m.key = prp.permission_key
ON CONFLICT DO NOTHING;

DELETE FROM production_role_permission
WHERE permission_key LIKE 'cue_list:%' OR permission_key LIKE 'cue:%';

-- ── 4. 词汇表删除 cue_list 旧级别（此时已无任何行引用） ─────────────────────────
DELETE FROM resource_permission_level
WHERE resource_type = 'cue_list' AND permission_level IN ('mount', 'manage');

COMMIT;
