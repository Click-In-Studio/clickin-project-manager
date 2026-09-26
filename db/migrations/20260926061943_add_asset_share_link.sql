-- migrate:up

CREATE TABLE asset_share_link (
  id                      TEXT        PRIMARY KEY,
  token                   TEXT        NOT NULL UNIQUE,
  asset_id                TEXT        NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  production_id           TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  allow_download          BOOLEAN     NOT NULL DEFAULT false,
  one_time                BOOLEAN     NOT NULL DEFAULT false,
  note                    TEXT,
  expires_at              TIMESTAMPTZ NOT NULL,
  created_by              UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at              TIMESTAMPTZ,
  redeemed_at             TIMESTAMPTZ,
  session_secret_hash     TEXT,
  session_last_seen_at    TIMESTAMPTZ,
  session_expires_at      TIMESTAMPTZ,
  CONSTRAINT asset_share_link_session_shape CHECK (
    (redeemed_at IS NULL AND session_secret_hash IS NULL
      AND session_last_seen_at IS NULL AND session_expires_at IS NULL)
    OR
    (one_time = true AND redeemed_at IS NOT NULL AND session_secret_hash IS NOT NULL
      AND session_last_seen_at IS NOT NULL AND session_expires_at IS NOT NULL)
  )
);

CREATE INDEX asset_share_link_asset_idx
  ON asset_share_link(asset_id, created_at DESC);
CREATE INDEX asset_share_link_production_idx
  ON asset_share_link(production_id, created_at DESC);

-- migrate:down

DROP TABLE IF EXISTS asset_share_link;
