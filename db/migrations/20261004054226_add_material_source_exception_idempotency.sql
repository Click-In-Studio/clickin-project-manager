-- migrate:up

ALTER TABLE production_material_source_exception
  ADD COLUMN idempotency_key TEXT,
  ADD CONSTRAINT material_source_exception_idempotency_key_check CHECK (
    idempotency_key IS NULL OR (
      length(idempotency_key) BETWEEN 8 AND 128
      AND idempotency_key !~ '[[:cntrl:]]'
    )
  );

CREATE UNIQUE INDEX production_material_source_exception_idempotency_unique
  ON production_material_source_exception (production_id, created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS production_material_source_exception_idempotency_unique;

ALTER TABLE production_material_source_exception
  DROP CONSTRAINT IF EXISTS material_source_exception_idempotency_key_check,
  DROP COLUMN IF EXISTS idempotency_key;
