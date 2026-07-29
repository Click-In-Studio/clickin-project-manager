-- Notification category tag for display purposes.
-- 'info'   普通通知 — informational, no action required
-- 'action' 待确认   — requires user action (confirms, RSVP, etc.)
-- 'warning'警告     — alert/warning (cue warnings, urgent notices)
ALTER TABLE user_notification
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'info'
  CHECK (category IN ('info', 'action', 'warning'));
