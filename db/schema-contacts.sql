-- Contact sheet import schema additions
-- Run against: script_editor database

ALTER TABLE feishu_user
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT;

ALTER TABLE production_member
  ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS photo_url TEXT;
