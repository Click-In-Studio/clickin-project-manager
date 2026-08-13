-- 两个指派面（2026-08-13 用户定稿）：event assignee ≠ task assignee。
--
--   名单权（谁参加）= event/<id>/assignees@create/delete（保留段，organizer 默认持有）
--   时刻权（几点到）= event/<id>/call_sheet@edit（跟组舞监 + organizer）
--   发布动作归舞监 role（模板 event/*/publication@create/delete）；
--   organizer 不再默认持有 publication@create（保留 edit/delete=修订/撤回）。
--   存量 organizer 的既有 publication@create 行**不追溯撤销**
--   （否则无舞监成员的剧组失去发布能力；新政策对新建 event 生效）。
--
-- 幂等，可重复执行。

BEGIN;

-- ── 1. 存量 organizer 补行（判据：持有该 event grants@edit 的 direct 行 = 创建者）──
INSERT INTO production_member_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by)
SELECT g.production_id, g.user_id, 'event', g.resource_id, s.sub, s.verb, 'direct', g.user_id
FROM production_member_grant g
CROSS JOIN (VALUES ('assignees', 'create'), ('assignees', 'delete'), ('call_sheet', 'edit')) AS s(sub, verb)
WHERE g.resource_type = 'event' AND g.resource_sub = 'grants' AND g.permission_level = 'edit'
  AND g.grant_source = 'direct' AND NOT g.is_revoked
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- ── 2. 存量跟组舞监补 call_sheet@edit（判据：event_stage_manager 现任名单）──
INSERT INTO production_member_grant
  (production_id, user_id, resource_type, resource_id, resource_sub,
   permission_level, grant_source, confirmed_by)
SELECT pe.production_id, esm.user_id, 'event', esm.event_id, 'call_sheet', 'edit', 'assigned', esm.user_id
FROM event_stage_manager esm
JOIN production_event pe ON pe.id = esm.event_id
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- ── 3. 舞监 role 模板：全内容 view + 发布/撤回 ────────────────────────────────
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('舞台监督', 'node:event/*@view'),
  ('舞台监督', 'node:event/*/publication@create'),
  ('舞台监督', 'node:event/*/publication@delete'),
  ('助理舞台监督', 'node:event/*@view'),
  ('助理舞台监督', 'node:event/*/publication@create'),
  ('助理舞台监督', 'node:event/*/publication@delete')
ON CONFLICT DO NOTHING;

-- 各演出'舞台监督'/'助理舞台监督' role 区间同步
INSERT INTO production_role_permission (role_id, permission_key)
SELECT pr.id, k.key
FROM production_role pr
CROSS JOIN (VALUES
  ('node:event/*@view'), ('node:event/*/publication@create'), ('node:event/*/publication@delete')
) AS k(key)
WHERE pr.name IN ('舞台监督', '助理舞台监督')
ON CONFLICT DO NOTHING;

-- ── 4. production 域基线（2026-08-13 用户定谳：view 面是基线非 sensitive）──────
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:production/*/meta@view'),
  ('*', 'node:production/*/mounts@view')
ON CONFLICT DO NOTHING;

COMMIT;
