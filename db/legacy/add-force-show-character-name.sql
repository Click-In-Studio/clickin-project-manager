-- Adds force_show_character_name column to script table.
-- Applied manually to production on 2026-06-04 after post-merge 500 incident;
-- CD will mark this as SKIP on next deploy since it's already applied.
ALTER TABLE script ADD COLUMN IF NOT EXISTS force_show_character_name BOOLEAN NOT NULL DEFAULT FALSE;
