-- 公告已读追踪：记录哪些成员已阅读哪条公告
CREATE TABLE IF NOT EXISTS announcement_read (
  announcement_id TEXT NOT NULL REFERENCES production_announcement(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS announcement_read_announcement_idx
  ON announcement_read(announcement_id);
