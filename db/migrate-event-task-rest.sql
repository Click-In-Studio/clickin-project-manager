-- 权限REST化 批B：event 域存量迁移 + tech_req→task 更名（总表批B + §0.8）。
--
-- 前置：add-task-verbs.sql（task 四动词 + event 域全局模板种子）已应用（同 commit）。
--
-- 内容：
--   1. tech_req 级别行拆解为 task 动词行集，rdm/rpm 类型更名，tech_req 词汇退役
--   2. event 旧级别行拆解（view/edit 行本身是合法树行保留；edit 补 view 行集；
--      publish/edit_published/revoke→publication；manage→全集），词汇删 4 个非动词级别
--   3. atomic 键活跃行 → 通配动词行，随后删除（task:view 退役无转换——assignee 语义）
--   4. production_role_permission 键 → 同表节点串（event:create 者获 chat 资格保真）
--   5. production_member_permission 键 → 节点串
--   6. dept 伪键（event:edit/event:create/tech_req:edit）→ production_dept_permission，数组清除
--
-- 幂等：全部 INSERT ON CONFLICT DO NOTHING。

BEGIN;

-- ── 1. tech_req → task ────────────────────────────────────────────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'task', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
JOIN (VALUES
  ('view',   '*',         'view'),
  ('edit',   '*',         'view'), ('edit',   '*',         'edit'),
  ('assign', '*',         'view'), ('assign', 'assignees', 'edit'),
  ('manage', '*',         'view'), ('manage', '*',         'edit'),
  ('manage', 'assignees', 'edit'), ('manage', '*',         'delete'),
  ('manage', 'grants',    'edit')
) AS s(level, sub, verb) ON s.level = rg.permission_level
WHERE rg.resource_type = 'tech_req' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM resource_grant WHERE resource_type = 'tech_req';
UPDATE resource_dept_manage  SET resource_type = 'task' WHERE resource_type = 'tech_req';
UPDATE resource_person_manage SET resource_type = 'task' WHERE resource_type = 'tech_req';
DELETE FROM resource_permission_level WHERE resource_type = 'tech_req';

-- ── 2. event 旧级别拆解（view/edit 行是合法树行，保留；补行集）────────────────
-- edit 行补行集（view + attach 子集合——tasks/reports 挂接语义，与 cue_list/cues 对称）
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'event', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
CROSS JOIN (VALUES ('meta', 'view'), ('details', 'view'),
                   ('tasks', 'create'), ('tasks', 'delete'),
                   ('reports', 'create'), ('reports', 'delete')) AS s(sub, verb)
WHERE rg.resource_type = 'event' AND rg.permission_level = 'edit' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- publish/edit_published/revoke → publication 动词行；manage → 全集
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'event', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
JOIN (VALUES
  ('publish',        'publication', 'create'),
  ('edit_published', 'publication', 'edit'),
  ('revoke',         'publication', 'delete'),
  ('manage', 'meta', 'view'), ('manage', 'details', 'view'), ('manage', '*', 'edit'),
  ('manage', 'tasks', 'create'), ('manage', 'tasks', 'delete'),
  ('manage', 'reports', 'create'), ('manage', 'reports', 'delete'),
  ('manage', 'publication', 'create'), ('manage', 'publication', 'edit'),
  ('manage', 'publication', 'delete'), ('manage', 'grants', 'edit')
) AS s(level, sub, verb) ON s.level = rg.permission_level
WHERE rg.resource_type = 'event' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM resource_grant
WHERE resource_type = 'event'
  AND permission_level IN ('manage', 'publish', 'edit_published', 'revoke');

DELETE FROM resource_permission_level
WHERE resource_type = 'event'
  AND permission_level IN ('manage', 'publish', 'edit_published', 'revoke');

-- ── 3. atomic 键活跃行 → 通配动词行，随后删除 ─────────────────────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT apg.production_id, apg.user_id, m.rtype, '*', m.sub, m.verb,
       apg.grant_source, apg.confirmed_by, apg.approval_id, apg.expires_at
FROM atomic_permission_grant apg
JOIN (VALUES
  ('event:create',              'event', '*',         'create'),
  ('event:create',              'event', 'reports',   'view'),
  ('event:follow',              'event', 'meta',      'view'),
  ('event:follow',              'event', 'details',   'view'),
  ('event:follow',              'event', 'followers', 'create'),
  ('event:view_call_sheet_any', 'event', 'call_sheet','view'),
  ('task:view_any',             'task',  '*',         'view'),
  ('task:delete_any',           'task',  '*',         'delete')
) AS m(key, rtype, sub, verb) ON m.key = apg.permission_key
WHERE NOT apg.is_revoked
  AND (apg.expires_at IS NULL OR apg.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM atomic_permission_grant
WHERE permission_key LIKE 'event:%' OR permission_key LIKE 'task:%';

-- ── 4. production_role_permission 键 → 同表节点串（chat 资格随 create 保真）────
INSERT INTO production_role_permission (role_id, permission_key)
SELECT DISTINCT prp.role_id, m.node_key
FROM production_role_permission prp
JOIN (VALUES
  ('event:create',              'node:event/*@create'),
  ('event:create',              'node:event/*/chat@create'),
  ('event:create',              'node:event/*/reports@view'),
  ('event:follow',              'node:event/*/meta@view'),
  ('event:follow',              'node:event/*/details@view'),
  ('event:follow',              'node:event/*/followers@create'),
  ('event:view_call_sheet_any', 'node:event/*/call_sheet@view'),
  ('task:view_any',             'node:task/*@view'),
  ('task:delete_any',           'node:task/*@delete')
) AS m(key, node_key) ON m.key = prp.permission_key
ON CONFLICT DO NOTHING;

DELETE FROM production_role_permission
WHERE permission_key LIKE 'event:%' OR permission_key LIKE 'task:%';

-- ── 5. member override 键 → 节点串 ────────────────────────────────────────────
INSERT INTO production_member_permission (production_id, user_id, permission, granted)
SELECT DISTINCT pmp.production_id, pmp.user_id, m.node_key, pmp.granted
FROM production_member_permission pmp
JOIN (VALUES
  ('event:create',              'node:event/*@create'),
  ('event:follow',              'node:event/*/meta@view'),
  ('event:follow',              'node:event/*/details@view'),
  ('event:follow',              'node:event/*/followers@create'),
  ('event:view_call_sheet_any', 'node:event/*/call_sheet@view'),
  ('task:view_any',             'node:task/*@view'),
  ('task:delete_any',           'node:task/*@delete')
) AS m(key, node_key) ON m.key = pmp.permission
ON CONFLICT DO NOTHING;

DELETE FROM production_member_permission
WHERE permission LIKE 'event:%' OR permission LIKE 'task:%';

-- ── 6. dept 伪键 → production_dept_permission ─────────────────────────────────
-- 'event:edit' × rdm(event) → 实例键；'tech_req:edit' × rdm(task) → 实例键
INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
SELECT DISTINCT rdm.production_id, rdm.dept_id, k.key
FROM resource_dept_manage rdm
JOIN production_dept pd ON pd.id = rdm.dept_id
CROSS JOIN LATERAL (VALUES
  ('node:' || rdm.resource_type || '/' || rdm.resource_id || '@view'),
  ('node:' || rdm.resource_type || '/' || rdm.resource_id || '@edit')
) AS k(key)
WHERE (rdm.resource_type = 'event' AND 'event:edit' = ANY(pd.permissions))
   OR (rdm.resource_type = 'task' AND 'tech_req:edit' = ANY(pd.permissions))
ON CONFLICT (dept_id, permission_key) DO NOTHING;

-- 'event:create' 数组伪键 → 集合 create 资格键
INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
SELECT pd.production_id, pd.id, k.key
FROM production_dept pd
CROSS JOIN (VALUES ('node:event/*@create'), ('node:event/*/reports@view')) AS k(key)
WHERE 'event:create' = ANY(pd.permissions)
ON CONFLICT (dept_id, permission_key) DO NOTHING;

UPDATE production_dept
SET permissions = array_remove(array_remove(array_remove(permissions,
      'event:edit'), 'event:create'), 'tech_req:edit')
WHERE 'event:edit' = ANY(permissions)
   OR 'event:create' = ANY(permissions)
   OR 'tech_req:edit' = ANY(permissions);

COMMIT;
