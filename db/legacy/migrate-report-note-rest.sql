-- 权限REST化 批C（PR-C2）：report/note 域权限迁移（总表批C + §0.8）。
--
-- 前提：PR-C1 本体拆分已部署（report/note = 挂载边，id 即边 id）。
-- report 是边类型（wiki 统一日存续）；note 是过渡类型（随 report 功能演进消亡）。
-- 词汇动词行批0 已备（report/note 各 create/delete；view/edit 沿用）。
--
-- 自足守卫：幂等，可重复执行。

BEGIN;

-- ── 1. RG report 级别行拆解 ───────────────────────────────────────────────────
-- view 行（'*','view'）保留为合法树行；edit 行补行集
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'report', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
CROSS JOIN (VALUES ('meta', 'view'), ('publication', 'view'),
                   ('notes', 'create'), ('notes', 'delete')) AS s(sub, verb)
WHERE rg.resource_type = 'report' AND rg.permission_level = 'edit' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- publish/edit_published/revoke → publication；manage → 全集
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'report', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
JOIN (VALUES
  ('publish',        'publication', 'create'),
  ('edit_published', 'publication', 'edit'),
  ('revoke',         'publication', 'delete'),
  ('manage', 'meta', 'view'), ('manage', 'publication', 'view'), ('manage', '*', 'edit'),
  ('manage', 'notes', 'create'), ('manage', 'notes', 'delete'),
  ('manage', 'publication', 'create'), ('manage', 'publication', 'edit'),
  ('manage', 'publication', 'delete'), ('manage', 'grants', 'edit')
) AS s(level, sub, verb) ON s.level = rg.permission_level
WHERE rg.resource_type = 'report' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM resource_grant
WHERE resource_type = 'report'
  AND permission_level IN ('manage', 'publish', 'edit_published', 'revoke');

-- RG note manage 拆解（view/edit 沿用为动词）
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT rg.production_id, rg.user_id, 'note', rg.resource_id, s.sub, s.verb,
       rg.grant_source, rg.confirmed_by, rg.approval_id, rg.expires_at
FROM resource_grant rg
JOIN (VALUES
  ('manage', '*', 'view'), ('manage', '*', 'edit'),
  ('manage', '*', 'delete'), ('manage', 'grants', 'edit')
) AS s(level, sub, verb) ON s.level = rg.permission_level
WHERE rg.resource_type = 'note' AND NOT rg.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM resource_grant WHERE resource_type = 'note' AND permission_level = 'manage';

DELETE FROM resource_permission_level
WHERE (resource_type = 'report' AND permission_level IN ('manage', 'publish', 'edit_published', 'revoke'))
   OR (resource_type = 'note' AND permission_level = 'manage');

-- ── 2. atomic 键活跃行 → 通配动词行，随后删除 ─────────────────────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by, approval_id, expires_at)
SELECT apg.production_id, apg.user_id, m.rtype, '*', m.sub, m.verb,
       apg.grant_source, apg.confirmed_by, apg.approval_id, apg.expires_at
FROM atomic_permission_grant apg
JOIN (VALUES
  ('report:create',             'event',  'reports', 'create'),
  ('report:reply',              'report', 'replies', 'create'),
  ('report:edit_comment_any',   'report', 'replies', 'edit'),
  ('report:delete_comment_any', 'report', 'replies', 'delete')
) AS m(key, rtype, sub, verb) ON m.key = apg.permission_key
WHERE NOT apg.is_revoked
  AND (apg.expires_at IS NULL OR apg.expires_at > NOW())
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

DELETE FROM atomic_permission_grant WHERE permission_key LIKE 'report:%';

-- ── 3. production_role_permission 键 → 节点串 ─────────────────────────────────
INSERT INTO production_role_permission (role_id, permission_key)
SELECT DISTINCT prp.role_id, m.node_key
FROM production_role_permission prp
JOIN (VALUES
  ('report:create',             'node:event/*/reports@create'),
  ('report:reply',              'node:report/*/replies@create'),
  ('report:edit_comment_any',   'node:report/*/replies@edit'),
  ('report:delete_comment_any', 'node:report/*/replies@delete')
) AS m(key, node_key) ON m.key = prp.permission_key
ON CONFLICT DO NOTHING;

DELETE FROM production_role_permission WHERE permission_key LIKE 'report:%';

-- ── 4. member override 键 → 节点串 ────────────────────────────────────────────
INSERT INTO production_member_permission (production_id, user_id, permission, granted)
SELECT DISTINCT pmp.production_id, pmp.user_id, m.node_key, pmp.granted
FROM production_member_permission pmp
JOIN (VALUES
  ('report:create',             'node:event/*/reports@create'),
  ('report:reply',              'node:report/*/replies@create'),
  ('report:edit_comment_any',   'node:report/*/replies@edit'),
  ('report:delete_comment_any', 'node:report/*/replies@delete')
) AS m(key, node_key) ON m.key = pmp.permission
ON CONFLICT DO NOTHING;

DELETE FROM production_member_permission WHERE permission LIKE 'report:%';

-- ── 5. 最后一枚 dept 伪键：'report:edit' × rdm(report) → 实例键，数组清除 ──────
INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
SELECT DISTINCT rdm.production_id, rdm.dept_id, k.key
FROM resource_dept_manage rdm
JOIN production_dept pd ON pd.id = rdm.dept_id
CROSS JOIN LATERAL (VALUES
  ('node:report/' || rdm.resource_id || '@view'),
  ('node:report/' || rdm.resource_id || '@edit')
) AS k(key)
WHERE rdm.resource_type = 'report' AND 'report:edit' = ANY(pd.permissions)
ON CONFLICT (dept_id, permission_key) DO NOTHING;

UPDATE production_dept
SET permissions = array_remove(permissions, 'report:edit')
WHERE 'report:edit' = ANY(permissions);

-- ── 6. 全局模板种子（保真：制作人的 report:create；SM/制作人已有 reports@view）──
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('制作人', 'node:event/*/reports@create')
ON CONFLICT DO NOTHING;

COMMIT;
