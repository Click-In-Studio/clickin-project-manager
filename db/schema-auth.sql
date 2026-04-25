-- Auth schema — run after schema.sql against the script_editor database

-- Feishu users who have logged in at least once
CREATE TABLE feishu_user (
  open_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  avatar_url     TEXT,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which users have access to which productions.
-- Super admins (is_super_admin = true) implicitly have access to all productions.
CREATE TABLE production_member (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL REFERENCES feishu_user(open_id) ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (production_id, open_id)
);
