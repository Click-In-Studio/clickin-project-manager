BEGIN;

CREATE TABLE IF NOT EXISTS event_milestone (
  event_id      TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  milestone_id  TEXT NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS event_milestone_milestone_idx
  ON event_milestone(milestone_id);

COMMIT;
