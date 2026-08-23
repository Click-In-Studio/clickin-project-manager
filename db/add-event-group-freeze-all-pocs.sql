-- Preserve every natural-person POC in an event-group freeze snapshot.
-- The head row keeps one representative for backwards-compatible display;
-- authorization reads all member rows marked here.
ALTER TABLE event_group_freeze_member
  ADD COLUMN IF NOT EXISTS was_poc BOOLEAN NOT NULL DEFAULT false;
