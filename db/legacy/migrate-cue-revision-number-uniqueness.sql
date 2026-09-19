-- Cue rows are physical revisions, so different versions may store the same logical
-- Cue number in separate rows. Per-version conflict checks remain in application code.

ALTER TABLE cue DROP CONSTRAINT IF EXISTS cue_cue_list_id_number_key;
