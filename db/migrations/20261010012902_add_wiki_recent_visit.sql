-- migrate:up
ALTER TABLE wiki ADD CONSTRAINT wiki_id_production_uniq UNIQUE (id, production_id);

CREATE TABLE wiki_recent_visit (
  id             TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id  TEXT NOT NULL,
  wiki_id        UUID NOT NULL,
  last_viewed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, production_id, wiki_id),
  FOREIGN KEY (wiki_id, production_id)
    REFERENCES wiki(id, production_id) ON DELETE CASCADE
);
CREATE INDEX wiki_recent_visit_order_idx
  ON wiki_recent_visit (user_id, production_id, last_viewed_at DESC, wiki_id DESC);
CREATE INDEX wiki_recent_visit_wiki_idx ON wiki_recent_visit (wiki_id, production_id);

-- migrate:down
DROP TABLE wiki_recent_visit;
ALTER TABLE wiki DROP CONSTRAINT wiki_id_production_uniq;
