-- Phase 7: 审批流 — approval_request 表
-- production_approval_config 已在 schema 中，此处不重建
-- user_notification / resource_grant / atomic_permission_grant 补列和 FK

-- ── approval_request ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_request (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT NOT NULL,

  subject_id      UUID NOT NULL REFERENCES app_user(id),
  type            TEXT NOT NULL CHECK (type IN (
                    'resource_access',
                    'member_exit',
                    'owner_transfer'
                  )),

  -- resource_access 专用字段（type='resource_access' 时非 NULL）
  resource_type       TEXT NULL,
  resource_id         TEXT NULL DEFAULT '*',
  resource_sub        TEXT NULL DEFAULT '*',
  permission_level    TEXT NULL,
  grant_type          TEXT NULL CHECK (grant_type IN ('permanent', 'ttl')),
  ttl_duration        INTERVAL NULL,
  note                TEXT NULL,

  CONSTRAINT approval_resource_fields_required
    CHECK (type != 'resource_access' OR (resource_type IS NOT NULL AND permission_level IS NOT NULL)),

  -- 无直属上级 → 初始 pending_resource；有直属上级 → 初始 pending_supervisor
  status          TEXT NOT NULL DEFAULT 'pending_resource'
                  CHECK (status IN (
                    'pending_supervisor',
                    'pending_resource',
                    'approved',
                    'rejected',
                    'cancelled'
                  )),

  escalation_chain  JSONB NOT NULL DEFAULT '[]',
  -- [{phase:'supervisor'|'resource', approverIds:[], notifiedAt:ISO, action?:'approved'|'rejected', actorId?, actedAt?}]

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ NULL,
  resolved_by     UUID NULL REFERENCES app_user(id),
  granted_at      TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS approval_request_production_status_idx
  ON approval_request (production_id, status);

CREATE INDEX IF NOT EXISTS approval_request_subject_idx
  ON approval_request (subject_id, production_id);

-- ── 给现有表补列 ──────────────────────────────────────────────────────────────

ALTER TABLE user_notification
  ADD COLUMN IF NOT EXISTS approval_request_id UUID REFERENCES approval_request(id) NULL;

CREATE INDEX IF NOT EXISTS user_notification_approval_idx
  ON user_notification (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- resource_grant / atomic_permission_grant 的 approval_id 列已存在，补 FK 约束
-- 使用 DO $$ 避免"约束已存在"报错
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_grant_approval_fk'
      AND table_name = 'resource_grant'
  ) THEN
    ALTER TABLE resource_grant
      ADD CONSTRAINT resource_grant_approval_fk
      FOREIGN KEY (approval_id) REFERENCES approval_request(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'atomic_permission_grant_approval_fk'
      AND table_name = 'atomic_permission_grant'
  ) THEN
    ALTER TABLE atomic_permission_grant
      ADD CONSTRAINT atomic_permission_grant_approval_fk
      FOREIGN KEY (approval_id) REFERENCES approval_request(id);
  END IF;
END $$;
