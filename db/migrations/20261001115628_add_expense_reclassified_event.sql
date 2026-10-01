-- migrate:up

-- 先以 NOT VALID 加宽枚举，再验证存量，最后替换旧约束；避免 ADD CHECK 直接持锁扫表。
ALTER TABLE production_expense_event
  ADD CONSTRAINT production_expense_event_event_type_check_v2
  CHECK (event_type IN (
    'draft_created', 'draft_saved', 'submitted', 'forwarded',
    'approved', 'rejected', 'withdrawn', 'reopened', 'reclassified',
    'document_added', 'document_removed', 'post_approval_document_added'
  )) NOT VALID;

ALTER TABLE production_expense_event
  VALIDATE CONSTRAINT production_expense_event_event_type_check_v2;

ALTER TABLE production_expense_event
  DROP CONSTRAINT production_expense_event_event_type_check;

ALTER TABLE production_expense_event
  RENAME CONSTRAINT production_expense_event_event_type_check_v2
  TO production_expense_event_event_type_check;

-- migrate:down

DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
