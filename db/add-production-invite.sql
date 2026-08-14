-- #156 邀请制：项目邀请（开放链接 + 定向邮件邀请共用一表）。
-- email NULL = 开放链接（任何登录用户可用）；非空 = 定向（登录身份的 email
-- identity 必须匹配）。preset_* = 接受时预配角色/部门（用户定谳 2026-08-14）。

CREATE TABLE IF NOT EXISTS production_invite (
  token           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  email           TEXT,
  preset_roles    TEXT[]      NOT NULL DEFAULT '{}',
  preset_dept_ids UUID[]      NOT NULL DEFAULT '{}',
  created_by      UUID        NOT NULL REFERENCES app_user(id),
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER,
  used_count      INTEGER     NOT NULL DEFAULT 0,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS production_invite_prod_idx
  ON production_invite (production_id, created_at DESC);
