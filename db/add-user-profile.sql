CREATE TABLE IF NOT EXISTS user_profile (
  user_id            UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  display_name       TEXT,
  bio                TEXT,
  avatar_url         TEXT,
  phone              TEXT,
  preferred_platform TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill existing users from feishu_user
INSERT INTO user_profile (user_id, name, avatar_url)
SELECT user_id, name, avatar_url
FROM feishu_user
ON CONFLICT (user_id) DO NOTHING;
