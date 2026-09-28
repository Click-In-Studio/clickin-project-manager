-- migrate:up
CREATE TABLE user_production_order (
  id            TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  sort_key      TEXT NOT NULL CHECK (sort_key ~ '^[0-9a-z]{10}$'),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, production_id)
);

CREATE INDEX user_production_order_user_sort_idx
  ON user_production_order(user_id, sort_key);


-- migrate:down
DROP TABLE IF EXISTS user_production_order;
