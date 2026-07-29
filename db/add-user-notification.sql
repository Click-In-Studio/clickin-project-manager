-- Personal notification inbox.
-- Each row is one notification delivered to one user.
-- Inbox cannot be disabled; external channel preferences are separate.

CREATE TABLE IF NOT EXISTS user_notification (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id   TEXT REFERENCES production(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  view_href       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ,
  action_required BOOLEAN NOT NULL DEFAULT false,
  actions         JSONB NOT NULL DEFAULT '[]',
  acted_at        TIMESTAMPTZ,
  action_result   JSONB,
  category        TEXT NOT NULL DEFAULT 'info'
                  CHECK (category IN ('info', 'action', 'warning')),
  expired_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS user_notification_user_created_idx
  ON user_notification(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_notification_user_unread_idx
  ON user_notification(user_id, read_at)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS user_notification_user_pending_idx
  ON user_notification(user_id, created_at DESC)
  WHERE action_required = true AND acted_at IS NULL;

CREATE INDEX IF NOT EXISTS user_notification_entity_idx
  ON user_notification(entity_type, entity_id);

-- Call time RSVP: soft response before the daily-call dispatch window.
-- rsvp: 'yes' | 'no' | 'tentative' — NULL means no response yet.
-- After the dispatch window the user moves to a hard confirm (confirmed_at).
ALTER TABLE event_call_time
  ADD COLUMN IF NOT EXISTS rsvp         TEXT,
  ADD COLUMN IF NOT EXISTS rsvp_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

