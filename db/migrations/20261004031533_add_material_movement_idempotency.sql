-- migrate:up

ALTER TABLE production_material_stock_movement
  ADD COLUMN idempotency_key TEXT;

ALTER TABLE production_material_stock_movement
  ADD CONSTRAINT material_movement_idempotency_key_format
  CHECK (idempotency_key IS NULL OR (
    char_length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key !~ '[[:cntrl:]]'
  ));

CREATE UNIQUE INDEX material_movement_idempotency_idx
  ON production_material_stock_movement (production_id, created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- migrate:down

DROP INDEX material_movement_idempotency_idx;
ALTER TABLE production_material_stock_movement
  DROP CONSTRAINT material_movement_idempotency_key_format,
  DROP COLUMN idempotency_key;
