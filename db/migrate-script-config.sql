-- Add per-production script configuration (page layout, inline stage delimiters)
ALTER TABLE production
  ADD COLUMN IF NOT EXISTS script_config JSONB NOT NULL DEFAULT '{}';
