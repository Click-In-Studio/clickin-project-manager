-- Add lyric/dialogue linear classifier boundary to tag_group
ALTER TABLE tag_group
  ADD COLUMN IF NOT EXISTS lyric_split_after_option_id TEXT
    REFERENCES tag_option(id) ON DELETE SET NULL;
