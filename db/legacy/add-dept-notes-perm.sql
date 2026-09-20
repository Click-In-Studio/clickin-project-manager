-- 批C 追加（C3）：notes 权限面——dept 锚 + 行动触发自动授权。
--
-- 设计（用户敲定）：
--   dept/<D>/notes@create|edit|delete = "给 D 部门提/管本部门 note" 的权限行
--   （dept = event_department，首次成为树上资源类型；production 级，不限 event——
--    未参与排练的道具部门也可被提 note）
--   POC 上任发三行、卸任收走（写点 diff，grant_source='auto'）；
--   导演类"任意部门发"= dept/*/notes@create 通配（模板可授）；
--   organizer 蹭 event details@edit 的蕴含保留（上下文）。
--   draft report 可见：dept 加入 event（schedule/task 两路）→ POC 发 event/<id>/reports@view。
--   "排除导演提的"：树无作者维度 → note 边记 created_via，ud 门 = dept 行 ∧ created_via='dept'。
--
-- 幂等，可重复执行。

BEGIN;

-- ── 1. dept 词汇（resource_grant FK 前置）─────────────────────────────────────
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('dept', 'view', 0), ('dept', 'create', 0), ('dept', 'edit', 0), ('dept', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ── 2. note 边 created_via（创建通道：dept=本部门 / wildcard=通配权 / moderator=event 编辑者）
ALTER TABLE event_report_note ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'dept'
  CHECK (created_via IN ('dept', 'wildcard', 'moderator'));

-- 存量修正：作者不属于该部门的 note 标 moderator（老门只有参与者/SM 两通道）
UPDATE event_report_note n SET created_via = 'moderator'
FROM wiki w
WHERE w.id = n.wiki_id
  AND (w.created_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM event_department_member edm
    WHERE edm.department_id = n.department_id AND edm.user_id = w.created_by
  ));

-- ── 3. 现有 POC 补 dept notes 三行（POC 上任触发的存量等价）──────────────────
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
SELECT ed.production_id, edm.user_id, 'dept', ed.id, 'notes', v.verb, 'auto'
FROM event_department_member edm
JOIN event_department ed ON ed.id = edm.department_id
CROSS JOIN (VALUES ('create'), ('edit'), ('delete')) AS v(verb)
WHERE edm.is_poc
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- ── 4. 参与部门的 POC 补 event/<id>/reports@view（dept 加入 event 触发的存量等价）
--     两路：schedule 参与（event_participant.department_id）+ tech req 关联部门
INSERT INTO resource_grant
  (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
SELECT DISTINCT pe.production_id, edm.user_id, 'event', pairs.event_id, 'reports', 'view', 'assigned'
FROM (
  SELECT ep.event_id, ep.department_id FROM event_participant ep WHERE ep.department_id IS NOT NULL
  UNION
  SELECT etr.event_id, etr.department_id FROM event_tech_req etr WHERE etr.department_id IS NOT NULL
) pairs
JOIN production_event pe ON pe.id = pairs.event_id
JOIN event_department_member edm ON edm.department_id = pairs.department_id AND edm.is_poc
ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false
DO NOTHING;

-- ── 5. 全局模板种子：导演任意部门发 note ─────────────────────────────────────
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('导演', 'node:dept/*/notes@create')
ON CONFLICT DO NOTHING;

COMMIT;
