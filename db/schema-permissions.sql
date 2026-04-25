CREATE TABLE IF NOT EXISTS production_member_permission (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  permission    TEXT NOT NULL,
  granted       BOOLEAN NOT NULL,
  PRIMARY KEY (production_id, open_id, permission)
);
