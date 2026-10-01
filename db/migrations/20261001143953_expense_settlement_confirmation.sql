-- migrate:up

ALTER TABLE production_expense
  ADD COLUMN settled_at TIMESTAMPTZ,
  ADD COLUMN settled_by UUID REFERENCES app_user(id);

ALTER TABLE production_expense
  ADD CONSTRAINT production_expense_settlement_check
  CHECK (
    (settled_at IS NULL AND settled_by IS NULL)
    OR (status = 'approved' AND settled_at IS NOT NULL AND settled_by IS NOT NULL)
  ) NOT VALID;

ALTER TABLE production_expense
  VALIDATE CONSTRAINT production_expense_settlement_check;

ALTER TABLE production_expense_event
  ADD CONSTRAINT production_expense_event_event_type_check_v2
  CHECK (event_type IN (
    'draft_created', 'draft_saved', 'submitted', 'forwarded',
    'approved', 'rejected', 'withdrawn', 'reopened', 'reclassified',
    'document_added', 'document_removed', 'post_approval_document_added',
    'settled', 'settlement_reopened'
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
