-- 权限REST化 批D：Asset 域迁移（总表批D + 隐私/公开模型）。
--
-- 设计（用户敲定，2026-08-12）：
--   能力票∧结构合取：asset/*/meta|file@view 通配=能力票，实际范围由挂载让渡决定，
--     不是 any 实例票（old any 语义经合取自然消解；存量全公开故零行为变化）
--   publication 面 = 老 mount 级别：挂载=publication@create、解除=@delete、
--     越隐私看=@view（保留段显式，真 any 票）——与 event/report draft 同构
--   share_downloadable 系消亡为规则："令牌含下载 ⟺ 发令牌者持有 file@view"
--   own 键退役由创建者行集承担（§0.4 own/any 二元组归宿）
--
-- 自足守卫：幂等，可重复执行；依赖 add-asset-visibility.sql（此处镜像守卫）。

BEGIN;

-- ── 0. 跨文件依赖守卫（add-asset-visibility.sql 镜像）─────────────────────────
ALTER TABLE asset ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE asset ALTER COLUMN is_public SET DEFAULT false;

-- ── 1. atomic 键活跃行 → 通配动词行 ──────────────────────────────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT DISTINCT apg.production_id, apg.user_id, 'asset', '*', m.sub, m.verb,
       apg.grant_source, apg.confirmed_by, apg.approval_id, apg.expires_at
FROM atomic_permission_grant apg
JOIN (VALUES
  ('asset:view',                   'meta',        'view'),
  ('asset:view_any',               'meta',        'view'),
  ('asset:download',               'file',        'view'),
  ('asset:download_any',           'file',        'view'),
  ('asset:share',                  'shares',      'create'),
  ('asset:share_downloadable',     'shares',      'create'),
  ('asset:share_any',              'shares',      'create'),
  ('asset:share_any_downloadable', 'shares',      'create'),
  ('asset:create',                 '*',           'create'),
  ('asset:rename_any',             'meta',        'edit'),
  ('asset:change_type_any',        'meta',        'edit'),
  ('asset:overwrite_any',          'file',        'create'),
  ('asset:delete_any',             '*',           'delete'),
  ('asset:mount_any',              'publication', 'create'),
  ('asset:unmount_any',            'publication', 'delete')
) AS m(key, sub, verb) ON m.key = apg.permission_key
WHERE NOT apg.is_revoked
  AND (apg.expires_at IS NULL OR apg.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- own 键（rename/overwrite/change_type/delete/mount/unmount）不转换：创建者行集承担（步骤 4）
DELETE FROM atomic_permission_grant WHERE permission_key LIKE 'asset:%';

-- ── 2. production_role_permission / member / dept 键 → 节点串 ─────────────────
INSERT INTO production_role_permission (role_id, permission_key)
SELECT DISTINCT prp.role_id, m.node_key
FROM production_role_permission prp
JOIN (VALUES
  ('asset:view',                   'node:asset/*/meta@view'),
  ('asset:view_any',               'node:asset/*/meta@view'),
  ('asset:download',               'node:asset/*/file@view'),
  ('asset:download_any',           'node:asset/*/file@view'),
  ('asset:share',                  'node:asset/*/shares@create'),
  ('asset:share_downloadable',     'node:asset/*/shares@create'),
  ('asset:share_any',              'node:asset/*/shares@create'),
  ('asset:share_any_downloadable', 'node:asset/*/shares@create'),
  ('asset:create',                 'node:asset/*@create'),
  ('asset:rename_any',             'node:asset/*/meta@edit'),
  ('asset:change_type_any',        'node:asset/*/meta@edit'),
  ('asset:overwrite_any',          'node:asset/*/file@create'),
  ('asset:delete_any',             'node:asset/*@delete'),
  ('asset:mount_any',              'node:asset/*/publication@create'),
  ('asset:unmount_any',            'node:asset/*/publication@delete')
) AS m(key, node_key) ON m.key = prp.permission_key
ON CONFLICT DO NOTHING;

DELETE FROM production_role_permission WHERE permission_key LIKE 'asset:%';

INSERT INTO production_member_permission (production_id, user_id, permission, granted)
SELECT DISTINCT pmp.production_id, pmp.user_id, m.node_key, pmp.granted
FROM production_member_permission pmp
JOIN (VALUES
  ('asset:view',                   'node:asset/*/meta@view'),
  ('asset:view_any',               'node:asset/*/meta@view'),
  ('asset:download',               'node:asset/*/file@view'),
  ('asset:download_any',           'node:asset/*/file@view'),
  ('asset:share',                  'node:asset/*/shares@create'),
  ('asset:share_downloadable',     'node:asset/*/shares@create'),
  ('asset:share_any',              'node:asset/*/shares@create'),
  ('asset:share_any_downloadable', 'node:asset/*/shares@create'),
  ('asset:create',                 'node:asset/*@create'),
  ('asset:rename_any',             'node:asset/*/meta@edit'),
  ('asset:change_type_any',        'node:asset/*/meta@edit'),
  ('asset:overwrite_any',          'node:asset/*/file@create'),
  ('asset:delete_any',             'node:asset/*@delete'),
  ('asset:mount_any',              'node:asset/*/publication@create'),
  ('asset:unmount_any',            'node:asset/*/publication@delete')
) AS m(key, node_key) ON m.key = pmp.permission
ON CONFLICT DO NOTHING;

DELETE FROM production_member_permission WHERE permission LIKE 'asset:%';

INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
SELECT DISTINCT pdp.production_id, pdp.dept_id, m.node_key
FROM production_dept_permission pdp
JOIN (VALUES
  ('asset:view',                   'node:asset/*/meta@view'),
  ('asset:view_any',               'node:asset/*/meta@view'),
  ('asset:download',               'node:asset/*/file@view'),
  ('asset:download_any',           'node:asset/*/file@view'),
  ('asset:share',                  'node:asset/*/shares@create'),
  ('asset:share_downloadable',     'node:asset/*/shares@create'),
  ('asset:share_any',              'node:asset/*/shares@create'),
  ('asset:share_any_downloadable', 'node:asset/*/shares@create'),
  ('asset:create',                 'node:asset/*@create'),
  ('asset:rename_any',             'node:asset/*/meta@edit'),
  ('asset:change_type_any',        'node:asset/*/meta@edit'),
  ('asset:overwrite_any',          'node:asset/*/file@create'),
  ('asset:delete_any',             'node:asset/*@delete'),
  ('asset:mount_any',              'node:asset/*/publication@create'),
  ('asset:unmount_any',            'node:asset/*/publication@delete')
) AS m(key, node_key) ON m.key = pdp.permission_key
ON CONFLICT (dept_id, permission_key) DO NOTHING;

DELETE FROM production_dept_permission WHERE permission_key LIKE 'asset:%';

-- dept.permissions[] 数组清除（若有残留）
UPDATE production_dept
SET permissions = (SELECT COALESCE(array_agg(p), '{}') FROM unnest(permissions) AS p WHERE p NOT LIKE 'asset:%')
WHERE EXISTS (SELECT 1 FROM unnest(permissions) AS p WHERE p LIKE 'asset:%');

-- ── 3. RG asset 级别行拆解 ────────────────────────────────────────────────────
-- view/edit 沿用为动词（'*' 树行保留），但需补齐 '*' 通配覆盖不到的行：
--   view → +publication@view（保留段：实例显式授权本含隐私可见）
--   edit → +file@create（动词不同不被 '*'@edit 覆盖）
-- mount/manage 拆解后删除。
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'asset', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
JOIN (VALUES
  ('view',  'publication', 'view'),
  ('edit',  'file',        'create'),
  ('mount', 'publication', 'create'), ('mount', 'publication', 'delete'),
  ('manage', 'meta', 'edit'), ('manage', 'file', 'create'),
  ('manage', 'publication', 'view'), ('manage', 'publication', 'create'),
  ('manage', 'publication', 'delete'), ('manage', 'grants', 'edit')
) AS s(level, sub, verb) ON s.level = rg.permission_level
WHERE rg.resource_type = 'asset' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM resource_grant
WHERE resource_type = 'asset' AND permission_level IN ('mount', 'manage');

DELETE FROM resource_permission_level
WHERE resource_type = 'asset' AND permission_level IN ('mount', 'manage');

-- ── 4. 存量创建者行集 + person 归属（own 键退役的承担者，定式 C-5）────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by)
SELECT a.production_id, a.uploader_user_id, 'asset', a.id, s.sub, s.verb,
       'self_confirmed', a.uploader_user_id
FROM asset a
CROSS JOIN (VALUES
  ('meta', 'view'), ('file', 'view'),
  ('publication', 'view'), ('publication', 'create'), ('publication', 'delete'),
  ('meta', 'edit'), ('file', 'create'),
  ('*', 'delete'), ('shares', 'create'), ('grants', 'edit')
) AS s(sub, verb)
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

INSERT INTO resource_person_manage (production_id, user_id, resource_type, resource_id, resource_sub, established_by)
SELECT a.production_id, a.uploader_user_id, 'asset', a.id, '*', a.uploader_user_id
FROM asset a
ON CONFLICT DO NOTHING;

-- ── 5. 全局模板种子（保真 MEMBER_BASE 三枚 + 制作人 any 全系）─────────────────
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:asset/*/meta@view'),
  ('*', 'node:asset/*/file@view'),
  ('*', 'node:asset/*/shares@create')
ON CONFLICT DO NOTHING;

INSERT INTO grant_template (role_name, permission_key)
SELECT '制作人', k FROM (VALUES
  ('node:asset/*@create'), ('node:asset/*@delete'),
  ('node:asset/*/meta@edit'), ('node:asset/*/file@create'),
  ('node:asset/*/publication@create'), ('node:asset/*/publication@delete')
) AS t(k)
ON CONFLICT DO NOTHING;

COMMIT;
