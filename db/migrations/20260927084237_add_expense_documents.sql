-- migrate:up

ALTER TABLE asset
  ADD COLUMN file_version_policy TEXT NOT NULL DEFAULT 'append'
  CONSTRAINT asset_file_version_policy_check
    CHECK (file_version_policy IN ('append', 'single'));

ALTER TABLE production_expense
  ADD COLUMN invoice_requirement TEXT
    CONSTRAINT production_expense_invoice_requirement_check
      CHECK (invoice_requirement IN ('required', 'waived')),
  ADD COLUMN invoice_waiver_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE production_expense
  ADD CONSTRAINT production_expense_invoice_waiver_reason_check
    CHECK (invoice_requirement <> 'waived' OR btrim(invoice_waiver_reason) <> '');

CREATE TABLE production_expense_document (
  id            TEXT        PRIMARY KEY,
  expense_id    UUID        NOT NULL REFERENCES production_expense(id) ON DELETE CASCADE,
  asset_file_id TEXT        NOT NULL REFERENCES asset_file(id) ON DELETE RESTRICT,
  document_kind TEXT        NOT NULL
                CHECK (document_kind IN ('invoice', 'receipt', 'other')),
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (expense_id, asset_file_id)
);

CREATE INDEX production_expense_document_expense_idx
  ON production_expense_document(expense_id, created_at);
CREATE INDEX production_expense_document_file_idx
  ON production_expense_document(asset_file_id);

-- migrate:down

DROP TABLE production_expense_document;

ALTER TABLE production_expense
  DROP CONSTRAINT production_expense_invoice_waiver_reason_check,
  DROP COLUMN invoice_waiver_reason,
  DROP COLUMN invoice_requirement;

ALTER TABLE asset DROP COLUMN file_version_policy;
