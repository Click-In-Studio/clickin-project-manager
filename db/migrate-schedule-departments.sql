-- Track which departments/user-groups are associated with each schedule item.
-- When a dept is associated the UI pre-selects all its members as participants,
-- but the participant list in schedule_item_participant remains authoritative.
CREATE TABLE IF NOT EXISTS schedule_item_department (
  item_id  text NOT NULL REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  dept_id  text NOT NULL REFERENCES event_department(id)    ON DELETE CASCADE,
  PRIMARY KEY (item_id, dept_id)
);
