-- migrate:up

ALTER TABLE production_material_stock_lot
  ADD COLUMN creation_request_key TEXT,
  ADD COLUMN creation_request_index INTEGER,
  ADD COLUMN creation_received_now BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT material_stock_lot_creation_request_check CHECK (
    (creation_request_key IS NULL AND creation_request_index IS NULL)
    OR
    (creation_request_key IS NOT NULL
      AND length(creation_request_key) BETWEEN 8 AND 112
      AND creation_request_key !~ '[[:cntrl:]]'
      AND creation_request_index IS NOT NULL
      AND creation_request_index >= 0)
  );

CREATE UNIQUE INDEX production_material_stock_lot_creation_request_unique
  ON production_material_stock_lot
    (production_id, created_by, creation_request_key, creation_request_index)
  WHERE creation_request_key IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS production_material_stock_lot_creation_request_unique;

ALTER TABLE production_material_stock_lot
  DROP CONSTRAINT IF EXISTS material_stock_lot_creation_request_check,
  DROP COLUMN IF EXISTS creation_received_now,
  DROP COLUMN IF EXISTS creation_request_index,
  DROP COLUMN IF EXISTS creation_request_key;
