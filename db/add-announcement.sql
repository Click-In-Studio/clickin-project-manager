CREATE TABLE IF NOT EXISTS production_announcement (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  is_pinned     BOOLEAN NOT NULL DEFAULT false,
  created_by    UUID NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS production_announcement_production_idx
  ON production_announcement(production_id, created_at DESC);

-- Enforces at most one pinned announcement per production.
CREATE UNIQUE INDEX IF NOT EXISTS production_announcement_pinned_unique
  ON production_announcement(production_id) WHERE is_pinned = true;
