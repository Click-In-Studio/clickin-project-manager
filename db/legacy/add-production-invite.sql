-- #156 邀请制：项目邀请（开放链接 + 定向邀请 + 批量认领链接）。
-- 定向三態：email（邮箱定向）/ target_user_id（已注册用户定向）/
-- feishu_open_id（未注册飞书用户定向）——均 NULL 时为开放链接。
-- kind='claim' 的邀请配套 production_invite_claim 名单（按名字认领，逐行预配）。

CREATE TABLE IF NOT EXISTS production_invite (
  token           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  kind            TEXT        NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'claim')),
  email           TEXT,
  target_user_id  UUID        REFERENCES app_user(id) ON DELETE CASCADE,
  feishu_open_id  TEXT,
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

CREATE TABLE IF NOT EXISTS production_invite_claim (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token           UUID        NOT NULL REFERENCES production_invite(token) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  preset_roles    TEXT[]      NOT NULL DEFAULT '{}',
  preset_dept_ids UUID[]      NOT NULL DEFAULT '{}',
  claimed_by      UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  claimed_at      TIMESTAMPTZ,
  UNIQUE (token, name)
);

CREATE INDEX IF NOT EXISTS production_invite_claim_token_idx
  ON production_invite_claim (token);
