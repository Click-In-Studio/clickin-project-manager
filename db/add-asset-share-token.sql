CREATE TABLE IF NOT EXISTS asset_share_token (
  token         TEXT        PRIMARY KEY,
  asset_id      TEXT        NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  label         TEXT,
  expires_at    TIMESTAMPTZ,
  one_time      BOOLEAN     NOT NULL DEFAULT FALSE,
  used_at       TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS asset_share_token_asset_idx ON asset_share_token(asset_id);
