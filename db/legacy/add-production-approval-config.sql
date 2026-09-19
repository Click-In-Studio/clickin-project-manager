-- Phase 3 (#163): production_approval_config — 演出级审批 TTL 配置。
-- 每次演出创建时系统自动插入默认行（ttl_hours=24）。
-- 制作人及以上可修改 ttl_hours。

CREATE TABLE IF NOT EXISTS production_approval_config (
  production_id TEXT        PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  ttl_hours     INTEGER     NOT NULL DEFAULT 24
                            CHECK (ttl_hours > 0 AND ttl_hours <= 720),  -- 最大 30 天
  updated_by    UUID        NULL REFERENCES app_user(id),  -- NULL = 从未被人工修改
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
