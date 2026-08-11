-- 权限REST化 批0：为现有 8 个资源类型补充 create/delete 动词行。
-- （view/edit 已存在，动词化后字符串不变，直接沿用。）
--
-- sort_order = 0 是刻意的：迁移过渡期内旧 checker 仍做 sort_order >= 的线性
-- 比较，0 低于一切旧等级（最低为 1），保证新动词 grant 行永远不会被旧线性
-- 检查误判命中。线性语义随各批退役后，sort_order 仅剩 UI 展示用途。
--
-- 以 postgres 用户执行：
--   psql -U postgres -d production_manager -f db/add-rest-verbs.sql

INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('cue_list',    'create', 0), ('cue_list',    'delete', 0),
  ('scene',       'create', 0), ('scene',       'delete', 0),
  ('event',       'create', 0), ('event',       'delete', 0),
  ('report',      'create', 0), ('report',      'delete', 0),
  ('tech_req',    'create', 0), ('tech_req',    'delete', 0),
  ('note',        'create', 0), ('note',        'delete', 0),
  ('script_view', 'create', 0), ('script_view', 'delete', 0),
  ('asset',       'create', 0), ('asset',       'delete', 0)
ON CONFLICT DO NOTHING;
