-- Phase 2c: resource_permission_level lookup 表 + 补加 resource_grant.permission_level FK。
-- 任何引入新 resource_type 的 migration 文件，必须在同文件里先插入对应行，再写 grant 数据。

CREATE TABLE IF NOT EXISTS resource_permission_level (
  resource_type    TEXT    NOT NULL,
  permission_level TEXT    NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,  -- 用于 UI 展示权限级别高低
  PRIMARY KEY (resource_type, permission_level)
);

INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('cue_list',    'view',           1),
  ('cue_list',    'mount',          2),
  ('cue_list',    'edit',           3),
  ('cue_list',    'manage',         4),
  ('scene',       'view',           1),
  ('scene',       'mount',          2),
  ('scene',       'edit',           3),
  ('scene',       'manage',         4),
  ('event',       'view',           1),
  ('event',       'edit',           2),
  ('event',       'publish',        3),
  ('event',       'edit_published', 4),
  ('event',       'revoke',         5),
  ('event',       'manage',         6),
  ('report',      'view',           1),
  ('report',      'edit',           2),
  ('report',      'publish',        3),
  ('report',      'edit_published', 4),
  ('report',      'revoke',         5),
  ('report',      'manage',         6),
  ('tech_req',    'view',           1),
  ('tech_req',    'edit',           2),
  ('tech_req',    'assign',         3),
  ('tech_req',    'manage',         4),
  ('note',        'view',           1),
  ('note',        'edit',           2),
  ('note',        'manage',         3),
  ('script_view', 'view',           1),
  ('script_view', 'edit',           2),
  ('script_view', 'manage',         3),
  ('asset',       'view',           1),
  ('asset',       'mount',          2),
  ('asset',       'edit',           3),
  ('asset',       'manage',         4)
ON CONFLICT DO NOTHING;

-- 补加 FK 约束（DEFERRABLE 允许在同一事务内先插 grant 再插 level）
ALTER TABLE resource_grant
  ADD CONSTRAINT resource_grant_level_fk
  FOREIGN KEY (resource_type, permission_level)
  REFERENCES resource_permission_level (resource_type, permission_level)
  DEFERRABLE INITIALLY DEFERRED;
