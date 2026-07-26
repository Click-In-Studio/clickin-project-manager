-- ── Platform identities ───────────────────────────────────────────────────────
-- One row per (platform, platform_user_id). A user can have multiple identities
-- across different platforms and multiple identities on the same platform.

CREATE TABLE IF NOT EXISTS user_platform_identity (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  platform_id      TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  label            TEXT,
  is_login_method  BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, platform_user_id)
);

CREATE INDEX IF NOT EXISTS upi_user_id_idx ON user_platform_identity(user_id);

-- ── Notification preference ───────────────────────────────────────────────────
-- Three-tier routing: production → org (populated by #144) → global.
-- scope_type: 'global' | 'org' | 'production'
-- scope_id: '' for global, org_id for org, production_id for production.

CREATE TABLE IF NOT EXISTS notification_preference (
  user_id              UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  scope_type           TEXT NOT NULL,
  scope_id             TEXT NOT NULL DEFAULT '',
  platform_identity_id UUID NOT NULL REFERENCES user_platform_identity(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, scope_type, scope_id)
);

-- ── Production platform channel ───────────────────────────────────────────────
-- org_id NULL = project-level single channel (current).
-- org_id set = org-scoped channel (#144 multi-org routing).

CREATE TABLE IF NOT EXISTS production_platform_channel (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id       TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  org_id              TEXT,
  platform_id         TEXT NOT NULL,
  platform_channel_id TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- COALESCE so (production_id, NULL) and (production_id, 'x') are distinct rows
-- but only one NULL per production is allowed.
CREATE UNIQUE INDEX IF NOT EXISTS ppc_prod_org_uniq
  ON production_platform_channel(production_id, COALESCE(org_id, ''));

-- ── Seed existing Feishu users ────────────────────────────────────────────────
-- Populate user_platform_identity from feishu_user so existing users are
-- immediately reachable by the platform-agnostic notification router.

INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method)
SELECT user_id, 'feishu', open_id, true
FROM feishu_user
ON CONFLICT (platform_id, platform_user_id) DO NOTHING;
