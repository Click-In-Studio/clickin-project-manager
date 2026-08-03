-- Phase 2c: atomic_permission_grant 表 — 原子权限的个人 grant 记录。
-- 与 resource_grant 平行，存储 permission_key（如 script:view）的个人授权。
-- approval_id FK 等 approval_request 表（Phase 6）创建后再补约束。

CREATE TABLE IF NOT EXISTS atomic_permission_grant (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  permission_key  TEXT        NOT NULL,   -- 'script:view' | 'script:edit_content' | 'cue_list:create' | ...
  grant_source    TEXT        NOT NULL CHECK (grant_source IN (
                    'self_confirmed',  -- 用户主动确认（三级 UX 触发）
                    'auto',            -- 仅用于加入演出时的基础 grant
                    'approval',        -- 申请流审批通过后写入
                    'direct',          -- 制作人或 Owner 直接授权
                    'assigned'         -- 操作触发型：指定行为本身即授权，接收方无需确认
                  )),
  confirmed_by    UUID        NULL REFERENCES app_user(id),  -- auto grant 时为 NULL
  approval_id     UUID        NULL,      -- 待 approval_request 表（Phase 6）创建后加 FK 约束
  is_revoked      BOOLEAN     NOT NULL DEFAULT false,
  revoked_reason  TEXT        NULL CHECK (revoked_reason IN (
                    'role_change', 'dept_change', 'poc_change', 'manual'
                  )),
  expires_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index：同一用户在同一演出内每个 permission_key 只有一条未撤销记录。
CREATE UNIQUE INDEX IF NOT EXISTS atomic_permission_grant_active_unique_idx
  ON atomic_permission_grant (production_id, user_id, permission_key)
  WHERE is_revoked = false;

CREATE INDEX IF NOT EXISTS atomic_permission_grant_lookup_idx
  ON atomic_permission_grant (production_id, user_id)
  WHERE is_revoked = false;
