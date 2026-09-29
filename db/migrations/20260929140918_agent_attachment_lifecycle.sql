-- migrate:up

ALTER TABLE agent_session_attachment
  DROP CONSTRAINT agent_session_attachment_status_check;

ALTER TABLE agent_session_attachment
  ADD COLUMN last_referenced_at TIMESTAMPTZ NULL,
  ADD COLUMN expires_at TIMESTAMPTZ NULL,
  ADD COLUMN absolute_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  ADD COLUMN release_until TIMESTAMPTZ NULL,
  ADD COLUMN deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN promoted_asset_id TEXT NULL REFERENCES asset(id) ON DELETE SET NULL,
  ADD CONSTRAINT agent_session_attachment_status_check
    CHECK (status IN ('pending', 'ready', 'released', 'deleting', 'expired', 'promoted'));

UPDATE agent_session_attachment
SET expires_at = CASE
  WHEN status = 'pending' THEN created_at + interval '2 hours'
  ELSE COALESCE(ready_at, created_at) + interval '24 hours'
END,
absolute_expires_at = created_at + interval '30 days';

ALTER TABLE agent_session_attachment
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '2 hours');

CREATE INDEX agent_session_attachment_expiry_idx
  ON agent_session_attachment (expires_at)
  WHERE status IN ('pending', 'ready', 'released');

CREATE TABLE agent_attachment_object (
  id              TEXT        PRIMARY KEY,
  attachment_id   TEXT        NULL REFERENCES agent_session_attachment(id) ON DELETE SET NULL,
  user_id         UUID        NOT NULL,
  session_id      TEXT        NOT NULL,
  kind            TEXT        NOT NULL CHECK (kind IN ('original', 'doc_ir', 'mmp_result')),
  r2_key          TEXT        NOT NULL UNIQUE,
  byte_size       BIGINT      NOT NULL CHECK (byte_size >= 0),
  status          TEXT        NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'present', 'delete_pending', 'deleting', 'deleted', 'transferred')),
  attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NULL,
  last_error      TEXT        NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX agent_attachment_object_original_idx
  ON agent_attachment_object (attachment_id)
  WHERE kind = 'original' AND attachment_id IS NOT NULL;
CREATE INDEX agent_attachment_object_gc_idx
  ON agent_attachment_object (next_attempt_at, created_at)
  WHERE status = 'delete_pending';
CREATE INDEX agent_attachment_object_user_quota_idx
  ON agent_attachment_object (user_id, status);

INSERT INTO agent_attachment_object
  (id, attachment_id, user_id, session_id, kind, r2_key, byte_size, status, created_at)
SELECT 'aao_mig_' || md5(a.id), a.id, s.user_id, a.session_id, 'original', a.r2_key,
       a.file_size, CASE WHEN a.status = 'ready' THEN 'present' ELSE 'reserved' END, a.created_at
FROM agent_session_attachment a
JOIN agent_session s ON s.id = a.session_id;

CREATE TABLE agent_run_attachment_access (
  run_id          TEXT        NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  attachment_id   TEXT        NOT NULL REFERENCES agent_session_attachment(id) ON DELETE CASCADE,
  access_kind     TEXT        NOT NULL CHECK (access_kind IN ('attached', 'preflight', 'read', 'mmp_capability')),
  succeeded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, attachment_id, access_kind)
);

COMMENT ON TABLE agent_session_attachment IS
  'AI 会话私有的临时附件；可提升为资产，逻辑墓碑与物理对象回收分离。';
COMMENT ON TABLE agent_attachment_object IS
  '会话附件及其派生 R2 对象的独立回收账本；session/attachment 删除后仍保留重试线索。';
COMMENT ON TABLE agent_run_attachment_access IS
  '一轮运行成功处理附件的证据；用于限制 AI 只能释放本轮实际接触过的附件。';

-- migrate:down

DO $$ BEGIN
  RAISE EXCEPTION 'irreversible: agent attachment lifecycle backfill and state transition';
END $$;
