-- 权限REST化 批F：治理域迁移（42 行）。
--
-- 设计（总表批F + 2026-08-13 用户拍板）：
--   SENSITIVE/ROOT 最简单：都是 production 所有权（恒过 owner 审批流），
--   不涉及资源问题——纯迁移无决策点；拆得越细审批越简单（producer 四键四节点）
--   production:archive 一键覆盖归档+解除 → archival@create + @delete 两行（不拆键）
--   通讯录并入 member 树：contacts:view → member meta+contact 两面（成员默认）；
--   contacts:import 与 production:import_members 同归宿 member/*/imports@create（保留段）
--   org_dept = production_dept 组织树（与批C3 dept=event_department 区分）
--   ROOT 三键（delete/transfer_owner/restore_checkpoint）：节点入树但代码判定
--   owner-only（行不发不查）
--
-- 自足守卫：幂等；依赖 add-governance-verbs.sql（此处镜像守卫）。

BEGIN;

-- ── 0. 跨文件依赖守卫 ─────────────────────────────────────────────────────────
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('production',   'view', 0), ('production',   'create', 0), ('production',   'edit', 0), ('production',   'delete', 0),
  ('member',       'view', 0), ('member',       'create', 0), ('member',       'edit', 0), ('member',       'delete', 0),
  ('producer',     'view', 0), ('producer',     'create', 0), ('producer',     'edit', 0), ('producer',     'delete', 0),
  ('role',         'view', 0), ('role',         'create', 0), ('role',         'edit', 0), ('role',         'delete', 0),
  ('org_dept',     'view', 0), ('org_dept',     'create', 0), ('org_dept',     'edit', 0), ('org_dept',     'delete', 0),
  ('milestone',    'view', 0), ('milestone',    'create', 0), ('milestone',    'edit', 0), ('milestone',    'delete', 0),
  ('announcement', 'view', 0), ('announcement', 'create', 0), ('announcement', 'edit', 0), ('announcement', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ── 1. 键映射（atomic 行 + 三表节点串共用）───────────────────────────────────
CREATE TEMP TABLE f_map (key TEXT, rtype TEXT, sub TEXT, verb TEXT) ON COMMIT DROP;
INSERT INTO f_map VALUES
  -- production 根（ROOT 三键节点入树；判定 owner-only 在代码层）
  ('production:delete',              'production', '*',                'delete'),
  ('production:transfer_owner',      'production', 'owner',            'edit'),
  ('production:restore_checkpoint',  'production', 'restores',         'create'),
  ('production:archive',             'production', 'archival',         'create'),
  ('production:archive',             'production', 'archival',         'delete'),
  ('production:rename',              'production', 'meta/name',        'edit'),
  ('production:change_avatar',       'production', 'meta/avatar',      'edit'),
  ('production:edit_description',    'production', 'meta/description', 'edit'),
  ('production:change_type',         'production', 'meta/type',        'edit'),
  ('production:change_language',     'production', 'meta/language',    'edit'),
  ('production:manage_integrations', 'production', 'integrations',     'edit'),
  ('production:manage_config',       'production', 'config',           'edit'),
  ('production:mount',               'production', 'mounts',           'create'),
  ('production:unmount',             'production', 'mounts',           'delete'),
  -- producer 四键四节点（SENSITIVE 恒过 owner 审批，拆细审批更简单）
  ('production:producer_invite',     'producer', 'invitations',        'create'),
  ('production:producer_promote',    'producer', '*',                  'create'),
  ('production:producer_demote',     'producer', '*',                  'delete'),
  ('production:producer_kick',       'producer', 'membership',         'delete'),
  -- member（含通讯录并入 + 两枚 import 键同归宿 imports 保留段）
  ('production:import_members',      'member', 'imports',              'create'),
  ('contacts:import',                'member', 'imports',              'create'),
  ('contacts:view',                  'member', 'meta',                 'view'),
  ('contacts:view',                  'member', 'contact',              'view'),
  ('members:invite',                 'member', '*',                    'create'),
  ('members:kick',                   'member', '*',                    'delete'),
  ('members:change_role',            'member', 'roles',                'edit'),
  ('members:manage_overrides',       'member', 'overrides',            'edit'),
  -- role
  ('role:create',                    'role', '*',                      'create'),
  ('role:rename',                    'role', 'meta/name',              'edit'),
  ('role:delete',                    'role', '*',                      'delete'),
  ('role:assign_permission',         'role', 'grants',                 'edit'),
  -- org_dept（production_dept 组织树）
  ('dept:create',                    'org_dept', '*',                  'create'),
  ('dept:dismiss',                   'org_dept', '*',                  'delete'),
  ('dept:rename',                    'org_dept', 'meta/name',          'edit'),
  ('dept:change_type',               'org_dept', 'meta/type',          'edit'),
  ('dept:add_member',                'org_dept', 'members',            'create'),
  ('dept:delete_member',             'org_dept', 'members',            'delete'),
  ('dept:set_poc',                   'org_dept', 'poc',                'create'),
  ('dept:unset_poc',                 'org_dept', 'poc',                'delete'),
  -- milestone / announcement
  ('milestone:create',               'milestone', '*',                 'create'),
  ('milestone:manage',               'milestone', '*',                 'edit'),
  ('milestone:delete',               'milestone', '*',                 'delete'),
  ('announcement:create',            'announcement', '*',              'create'),
  ('announcement:edit',              'announcement', '*',              'edit'),
  ('announcement:delete',            'announcement', '*',              'delete');

-- SENSITIVE 键的 atomic 行按来源分流：approval/direct（owner 审批流产物）转换保真；
-- self_confirmed（自确认对 sensitive 本不该发生，老判定也不认）删除
DELETE FROM atomic_permission_grant
WHERE grant_source = 'self_confirmed'
  AND permission_key IN (SELECT key FROM (VALUES ('production:archive'),('production:rename'),('production:change_avatar'),
       ('production:edit_description'),('production:change_type'),('production:change_language'),
       ('production:manage_integrations'),('production:import_members'),
       ('production:producer_invite'),('production:producer_promote'),
       ('production:producer_demote'),('production:producer_kick'),('contacts:import')) AS sr(key));

-- ROOT 三键任何行都删（owner-only，连审批通道都没有）
DELETE FROM atomic_permission_grant
WHERE permission_key IN ('production:delete', 'production:transfer_owner', 'production:restore_checkpoint');

INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT DISTINCT apg.production_id, apg.user_id, m.rtype, '*', m.sub, m.verb,
       apg.grant_source, apg.confirmed_by, apg.approval_id, apg.expires_at
FROM atomic_permission_grant apg
JOIN f_map m ON m.key = apg.permission_key
WHERE NOT apg.is_revoked
  AND (apg.expires_at IS NULL OR apg.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM atomic_permission_grant
WHERE permission_key LIKE 'production:%' OR permission_key LIKE 'contacts:%'
   OR permission_key LIKE 'members:%' OR permission_key LIKE 'role:%'
   OR permission_key LIKE 'dept:%' OR permission_key LIKE 'milestone:%'
   OR permission_key LIKE 'announcement:%';

-- ── 2. 三张 permission 表键 → 节点串 ─────────────────────────────────────────
CREATE TEMP TABLE f_key_map (key TEXT, node_key TEXT) ON COMMIT DROP;
INSERT INTO f_key_map
SELECT DISTINCT key, 'node:' || rtype || '/*'
       || CASE WHEN sub = '*' THEN '' ELSE '/' || sub END || '@' || verb
FROM f_map;

-- SENSITIVE 键的区间行=审批流入口资格（用户定谳：有区间可申请、无区间连入口都没有、
-- 区间命中也不自确认）：照常转换为节点串。自确认禁用在代码层（isSensitiveNode）。
INSERT INTO production_role_permission (role_id, permission_key)
SELECT DISTINCT prp.role_id, m.node_key
FROM production_role_permission prp JOIN f_key_map m ON m.key = prp.permission_key
ON CONFLICT DO NOTHING;
DELETE FROM production_role_permission
WHERE permission_key LIKE 'production:%' OR permission_key LIKE 'contacts:%'
   OR permission_key LIKE 'members:%' OR permission_key LIKE 'role:%'
   OR permission_key LIKE 'dept:%' OR permission_key LIKE 'milestone:%'
   OR permission_key LIKE 'announcement:%';

INSERT INTO production_member_permission (production_id, user_id, permission, granted)
SELECT DISTINCT pmp.production_id, pmp.user_id, m.node_key, pmp.granted
FROM production_member_permission pmp JOIN f_key_map m ON m.key = pmp.permission
ON CONFLICT DO NOTHING;
DELETE FROM production_member_permission
WHERE permission LIKE 'production:%' OR permission LIKE 'contacts:%'
   OR permission LIKE 'members:%' OR permission LIKE 'role:%'
   OR permission LIKE 'dept:%' OR permission LIKE 'milestone:%'
   OR permission LIKE 'announcement:%';

INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
SELECT DISTINCT pdp.production_id, pdp.dept_id, m.node_key
FROM production_dept_permission pdp JOIN f_key_map m ON m.key = pdp.permission_key
ON CONFLICT (dept_id, permission_key) DO NOTHING;
DELETE FROM production_dept_permission
WHERE permission_key LIKE 'production:%' OR permission_key LIKE 'contacts:%'
   OR permission_key LIKE 'members:%' OR permission_key LIKE 'role:%'
   OR permission_key LIKE 'dept:%' OR permission_key LIKE 'milestone:%'
   OR permission_key LIKE 'announcement:%';

UPDATE production_dept
SET permissions = (SELECT COALESCE(array_agg(p), '{}') FROM unnest(permissions) AS p
                   WHERE p NOT LIKE 'production:%' AND p NOT LIKE 'contacts:%'
                     AND p NOT LIKE 'members:%' AND p NOT LIKE 'role:%'
                     AND p NOT LIKE 'dept:%' AND p NOT LIKE 'milestone:%'
                     AND p NOT LIKE 'announcement:%')
WHERE EXISTS (SELECT 1 FROM unnest(permissions) AS p
              WHERE p LIKE 'production:%' OR p LIKE 'contacts:%' OR p LIKE 'members:%'
                 OR p LIKE 'role:%' OR p LIKE 'dept:%' OR p LIKE 'milestone:%'
                 OR p LIKE 'announcement:%');

-- ── 3. 全局模板种子（MEMBER_BASE 保真：contacts:view → member 两面）──────────
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:member/*/meta@view'),
  ('*', 'node:member/*/contact@view')
ON CONFLICT DO NOTHING;

COMMIT;
