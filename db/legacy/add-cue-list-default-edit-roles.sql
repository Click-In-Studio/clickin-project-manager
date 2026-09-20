-- Add default_edit_roles column to cue_list table.
-- This column stores a list of role names that have edit access to cues in this list by default,
-- before any per-user overrides in cue_list_permission take effect.
ALTER TABLE cue_list ADD COLUMN IF NOT EXISTS default_edit_roles TEXT[] NOT NULL DEFAULT '{}';
