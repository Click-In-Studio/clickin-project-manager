ALTER TABLE production ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Initialize existing rows: lower created_at → lower sort_order
UPDATE production
SET sort_order = subq.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
  FROM production
) AS subq
WHERE production.id = subq.id;
