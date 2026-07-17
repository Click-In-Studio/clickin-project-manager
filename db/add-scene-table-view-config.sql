CREATE TABLE IF NOT EXISTS scene_table_view_config (
  id            TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  view_name     TEXT NOT NULL DEFAULT '默认视图',
  is_default    BOOLEAN NOT NULL DEFAULT false,
  config        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scene_table_view_user_prod_idx
  ON scene_table_view_config (user_id, production_id);

-- Enforce at most one default view per user per production at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS scene_table_view_one_default_idx
  ON scene_table_view_config (user_id, production_id) WHERE is_default;
