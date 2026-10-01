-- migrate:up

ALTER TABLE production_expense
  ADD COLUMN merchant TEXT NOT NULL DEFAULT '',
  ADD COLUMN occurred_on DATE;

CREATE TABLE expense_document_recognition (
  asset_file_id TEXT PRIMARY KEY REFERENCES asset_file(id) ON DELETE CASCADE,
  status        TEXT NOT NULL
                CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'unavailable')),
  source_kind   TEXT
                CHECK (source_kind IS NULL OR source_kind IN ('pdf_text', 'ocr', 'pdf_text_ocr')),
  result        JSONB,
  parser_version TEXT NOT NULL,
  model_version  TEXT NOT NULL,
  last_error     TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expense_document_recognition_result_check
    CHECK ((status = 'succeeded') = (result IS NOT NULL))
);

-- migrate:down

DROP TABLE expense_document_recognition;

ALTER TABLE production_expense
  DROP COLUMN occurred_on,
  DROP COLUMN merchant;
