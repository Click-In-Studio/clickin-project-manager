-- 权限REST化 批B：task 资源类型四动词词汇（tech_req 整体更名 task 的承接类型）。
-- tech_req 旧级别（view/edit/assign/manage）在 migrate-event-task-rest.sql 中
-- 随数据更名一并退役；event 的 create/delete 动词已在批0（add-rest-verbs.sql）。
--
-- 以 postgres 用户执行：
--   psql -U postgres -d script_editor -f db/add-task-verbs.sql

INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('task', 'view',   0),
  ('task', 'create', 0),
  ('task', 'edit',   0),
  ('task', 'delete', 0)
ON CONFLICT DO NOTHING;

-- ── 全局模板种子：event 域（保真迁移现行为） ──────────────────────────────────
-- 成员基础（原 event:follow 的两职拆分）：订阅 + 目录/内容可读
INSERT INTO grant_template (role_name, permission_key) VALUES
  ('*', 'node:event/*/meta@view'),
  ('*', 'node:event/*/details@view'),
  ('*', 'node:event/*/followers@create')
ON CONFLICT DO NOTHING;

-- 事件管理角色（原 SM_EVENT_PERMS 持有者：舞台监督/制作人）
INSERT INTO grant_template (role_name, permission_key)
SELECT r.name, k.key
FROM (VALUES ('舞台监督'), ('制作人')) AS r(name)
CROSS JOIN (VALUES
  ('node:event/*@create'),
  ('node:event/*/chat@create'),
  ('node:event/*/call_sheet@view'),
  ('node:task/*@view'),
  ('node:task/*@delete')
) AS k(key)
ON CONFLICT DO NOTHING;

-- 导演系（原 DIRECTOR_EVENT_PERMS：task:view_any）
INSERT INTO grant_template (role_name, permission_key)
SELECT r.name, 'node:task/*@view'
FROM (VALUES ('导演'), ('副导演'), ('音乐导演')) AS r(name)
ON CONFLICT DO NOTHING;
