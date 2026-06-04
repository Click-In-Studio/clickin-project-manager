-- Migration: change block_tag.block_id from snapshot_id to logical block_id
--
-- Background:
--   block_tag.block_id previously referenced script(id) which stores snapshot_ids
--   (e.g. "sn_abc123") for blocks written via applyPatchToDB, and logical block_ids
--   (e.g. "mpzurz547x") for legacy blocks written via flushToDB (where script.id
--   = script.block_id).  The client always uses logical block_ids when reading and
--   writing tags, so any versioned block caused an FK violation on write.
--
-- What this migration does:
--   1. Drop the FK constraint from block_tag.block_id.
--   2. For rows whose block_id looks like a snapshot ("sn_" prefix), replace it
--      with the logical block_id from the script table.
--   3. Delete remaining "sn_" rows that could not be migrated (duplicate or orphan).
--
-- After this migration block_tag.block_id stores the logical block_id.
-- The ON DELETE CASCADE behaviour is no longer provided by the DB; orphaned rows
-- for deleted blocks are harmless (they're never matched by a lookup on the logical
-- block_id and can be cleaned up in a future pass if needed).

BEGIN;

-- 1. Drop FK constraint
ALTER TABLE block_tag DROP CONSTRAINT IF EXISTS block_tag_block_id_fkey;

-- 2. Migrate sn_ rows: replace snapshot_id with logical block_id.
--    Only update rows where no row with the same (logical_block_id, group_id)
--    already exists, to avoid PK conflicts.
UPDATE block_tag bt
SET block_id = s.block_id
FROM script s
WHERE s.id = bt.block_id
  AND bt.block_id LIKE 'sn_%'
  AND NOT EXISTS (
    SELECT 1 FROM block_tag bt2
    WHERE bt2.block_id = s.block_id
      AND bt2.group_id  = bt.group_id
  );

-- 3. Remove any remaining sn_ rows (either orphaned snapshots that have no
--    matching script row, or duplicates that were blocked in step 2).
DELETE FROM block_tag WHERE block_id LIKE 'sn_%';

COMMIT;
