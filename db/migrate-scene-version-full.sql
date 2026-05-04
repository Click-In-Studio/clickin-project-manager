-- Move scene metadata into scene_version so all fields are versioned together.
-- scene table becomes a pure identity anchor (id + production_id).

ALTER TABLE scene_version
  ADD COLUMN IF NOT EXISTS synopsis          TEXT,
  ADD COLUMN IF NOT EXISTS action_line       TEXT,
  ADD COLUMN IF NOT EXISTS music             TEXT,
  ADD COLUMN IF NOT EXISTS stage_notes       TEXT,
  ADD COLUMN IF NOT EXISTS expected_duration TEXT;

-- Copy existing metadata from scene into every scene_version row
UPDATE scene_version sv
SET
  synopsis          = s.synopsis,
  action_line       = s.action_line,
  music             = s.music,
  stage_notes       = s.stage_notes,
  expected_duration = s.expected_duration
FROM scene s
WHERE sv.scene_id = s.id;
