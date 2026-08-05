-- Phase 2c: DROP poc_block_write_from_children from production_dept_member.
-- This column was present in the initial Phase 2 schema; its semantics are fully
-- covered by poc_blocked_permissions[] per PRD D3. The table had no live data
-- at migration time (event_department migration happens in Phase 3).
ALTER TABLE production_dept_member DROP COLUMN IF EXISTS poc_block_write_from_children;
