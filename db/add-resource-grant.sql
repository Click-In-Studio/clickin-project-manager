-- Phase 1 (#158): resource_grant 表 — 所有实际权限的单一权威来源。
-- grant_source 区分五种授权来源：用户自我确认、系统自动、审批流、制作人直接授权、操作触发。
-- approval_id FK 等 approval_request 表（Phase 6）创建后再补约束。
-- permission_level FK → resource_permission_level（add-resource-permission-level.sql）创建后补加。

CREATE TABLE IF NOT EXISTS resource_grant (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  resource_type   TEXT        NOT NULL,
  resource_id     TEXT        NOT NULL DEFAULT '*',   -- 实例 ID；'*' = 所有实例
  resource_sub    TEXT        NOT NULL DEFAULT '*',   -- 子类型/字段；'*' = 所有子类型
  permission_level TEXT       NOT NULL,               -- FK → resource_permission_level 在 add-resource-permission-level.sql 中补加
  grant_source    TEXT        NOT NULL CHECK (grant_source IN (
                    'self_confirmed',  -- 用户主动确认（三级 UX 触发）
                    'auto',            -- 仅用于加入演出时的 3 条基础 grant（无用户触发行为）
                    'approval',        -- 申请流审批通过后系统写入
                    'direct',          -- 制作人或 Production Owner 直接授权
                    'assigned'         -- 操作触发型：指定行为本身即授权，接收方无需确认
                  )),
  confirmed_by    UUID        NULL REFERENCES app_user(id),  -- auto grant 时为 NULL
  approval_id     UUID        NULL,      -- 待 approval_request 表（Phase 6）创建后加 FK 约束
  is_revoked      BOOLEAN     NOT NULL DEFAULT false,
  revoked_reason  TEXT        NULL CHECK (revoked_reason IN (
                    'role_change', 'dept_change', 'dept_dissolved', 'poc_change', 'manual'
                  )),
  expires_at      TIMESTAMPTZ NULL,      -- NULL = 永久有效
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index：仅对未撤销 grant 去重。
-- 注意：不含 expires_at > NOW() 谓词——expired 行仍留在索引中，
-- 应用层写新 grant 前需先将旧 expired 行设 is_revoked=true。
CREATE UNIQUE INDEX IF NOT EXISTS resource_grant_active_unique_idx
  ON resource_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false;

-- 主查询索引（单点权限检查 + 批量拉取该用户全部 grants）
CREATE INDEX IF NOT EXISTS resource_grant_lookup_idx
  ON resource_grant (production_id, resource_type, resource_id, resource_sub, user_id)
  WHERE is_revoked = false;
