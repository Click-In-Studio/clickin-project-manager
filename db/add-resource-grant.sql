-- Phase 1 (#158): resource_grant 表 — 所有实际权限的单一权威来源。
-- grant_source 区分三种授权来源：用户自我确认、审批流、制作人直接授权。
-- approval_id FK 等 approval_request 表（Phase 6）创建后再补约束。

CREATE TABLE IF NOT EXISTS resource_grant (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  grantee_type    TEXT        NOT NULL CHECK (grantee_type IN ('user', 'dept')),
  grantee_id      TEXT        NOT NULL,
  resource_type   TEXT        NOT NULL,  -- 'cue_list' | 'script' | 'note' | 'tech_req' | '*'
  resource_id     TEXT        NULL,      -- NULL = 该类型所有资源（dept 级 grant）
  permission_level TEXT       NOT NULL CHECK (permission_level IN ('view', 'write', 'manage')),
  grant_source    TEXT        NOT NULL CHECK (grant_source IN (
                    'self_confirmed',  -- 用户在免审批区间内主动自我确认
                    'approval',        -- 申请流审批通过后系统创建
                    'direct'           -- 制作人或 POC 直接授权
                  )),
  confirmed_by    UUID        NOT NULL REFERENCES app_user(id),
  approval_id     UUID        NULL,      -- 待 approval_request 表（Phase 6）创建后加 FK 约束
  is_revoked      BOOLEAN     NOT NULL DEFAULT false,
  revoked_reason  TEXT        NULL CHECK (revoked_reason IN ('role_change', 'dept_change', 'manual')),
  expires_at      TIMESTAMPTZ NULL,      -- NULL = 永久有效
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT resource_grant_active_unique
    UNIQUE (production_id, grantee_type, grantee_id, resource_type, resource_id, permission_level)
    DEFERRABLE INITIALLY DEFERRED
);

-- Partial unique index：仅对未撤销的 grant 去重（等价 PRD 中 WHERE is_revoked = false 约束）
CREATE UNIQUE INDEX IF NOT EXISTS resource_grant_active_unique_idx
  ON resource_grant (production_id, grantee_type, grantee_id, resource_type,
                     COALESCE(resource_id, ''), permission_level)
  WHERE is_revoked = false;

CREATE INDEX IF NOT EXISTS resource_grant_grantee_idx
  ON resource_grant (production_id, grantee_type, grantee_id);

CREATE INDEX IF NOT EXISTS resource_grant_resource_idx
  ON resource_grant (production_id, resource_type, resource_id);
