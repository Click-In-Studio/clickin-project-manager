-- migrate:up

ALTER TABLE production_material_stock_lot
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'existing',
  ADD COLUMN source_label TEXT NOT NULL DEFAULT '',
  ADD COLUMN source_reference TEXT NOT NULL DEFAULT '',
  ADD COLUMN source_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN expected_arrival_at TIMESTAMPTZ,
  ADD COLUMN return_due_at TIMESTAMPTZ,
  ADD COLUMN return_due_quantity NUMERIC(18,3),
  ADD CONSTRAINT material_stock_lot_source_type_check
    CHECK (source_type IN ('existing', 'purchased', 'produced', 'rented', 'borrowed')),
  ADD CONSTRAINT material_stock_lot_return_obligation_check CHECK (
    (source_type IN ('rented', 'borrowed')
      AND btrim(source_label) <> ''
      AND return_due_quantity IS NOT NULL
      AND return_due_quantity > 0
      AND return_due_quantity <= confirmed_quantity)
    OR
    (source_type NOT IN ('rented', 'borrowed')
      AND return_due_at IS NULL
      AND return_due_quantity IS NULL)
  );

ALTER TABLE production_material_stock_movement
  ADD COLUMN occurred_at TIMESTAMPTZ;

-- 历史流水不可由业务改写；迁移期间只把业务发生时间无损回填为原创建时间。
DROP TRIGGER production_material_stock_movement_immutable
  ON production_material_stock_movement;
UPDATE production_material_stock_movement SET occurred_at = created_at;
CREATE TRIGGER production_material_stock_movement_immutable
BEFORE UPDATE OR DELETE ON production_material_stock_movement
FOR EACH ROW EXECUTE FUNCTION reject_material_stock_history_change();

ALTER TABLE production_material_stock_movement
  ALTER COLUMN occurred_at SET DEFAULT now(),
  ALTER COLUMN occurred_at SET NOT NULL;

CREATE TABLE production_material_source_return (
  id            TEXT        PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  lot_id        TEXT        NOT NULL,
  movement_id   TEXT        NOT NULL UNIQUE
    REFERENCES production_material_stock_movement(id) ON DELETE CASCADE,
  returned_at   TIMESTAMPTZ NOT NULL,
  note          TEXT        NOT NULL DEFAULT '',
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT material_source_return_lot_fk
    FOREIGN KEY (lot_id, production_id)
    REFERENCES production_material_stock_lot(id, production_id) ON DELETE RESTRICT
);

CREATE INDEX production_material_source_return_lot_idx
  ON production_material_source_return (production_id, lot_id, returned_at, id);

CREATE TABLE production_material_source_exception (
  id                    TEXT          PRIMARY KEY,
  production_id         TEXT          NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  lot_id                TEXT          NOT NULL,
  source_return_id      TEXT          REFERENCES production_material_source_return(id) ON DELETE CASCADE,
  kind                  TEXT          NOT NULL CHECK (kind IN ('lost', 'damaged', 'short')),
  quantity              NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  note                  TEXT          NOT NULL DEFAULT '',
  resolves_exception_id TEXT          UNIQUE
    REFERENCES production_material_source_exception(id) ON DELETE CASCADE,
  occurred_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by            UUID          NOT NULL REFERENCES app_user(id),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT material_source_exception_lot_fk
    FOREIGN KEY (lot_id, production_id)
    REFERENCES production_material_stock_lot(id, production_id) ON DELETE RESTRICT,
  CONSTRAINT material_source_exception_not_self
    CHECK (resolves_exception_id IS NULL OR resolves_exception_id <> id)
);

CREATE INDEX production_material_source_exception_lot_idx
  ON production_material_source_exception (production_id, lot_id, occurred_at, id);

CREATE OR REPLACE FUNCTION enforce_material_stock_lot_type() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  material_strategy TEXT;
  material_scale SMALLINT;
BEGIN
  SELECT tracking_strategy, quantity_scale
    INTO material_strategy, material_scale
    FROM production_material
   WHERE id = NEW.material_id AND production_id = NEW.production_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'material not found for stock lot' USING ERRCODE = '23503';
  END IF;
  IF NEW.confirmed_quantity <> round(NEW.confirmed_quantity, material_scale)
     OR (NEW.return_due_quantity IS NOT NULL
         AND NEW.return_due_quantity <> round(NEW.return_due_quantity, material_scale)) THEN
    RAISE EXCEPTION 'material quantity exceeds configured precision'
      USING ERRCODE = '23514', CONSTRAINT = 'material_quantity_scale';
  END IF;
  IF material_strategy = 'serialized'
     AND (NEW.confirmed_quantity <> 1
          OR (NEW.return_due_quantity IS NOT NULL AND NEW.return_due_quantity <> 1)) THEN
    RAISE EXCEPTION 'serialized material lot quantity must be one'
      USING ERRCODE = '23514', CONSTRAINT = 'material_serialized_lot_quantity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_material_source_return() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_source_type TEXT;
  due_quantity NUMERIC(18,3);
  returned_quantity NUMERIC(18,3);
  movement_record production_material_stock_movement%ROWTYPE;
BEGIN
  SELECT source_type, return_due_quantity
    INTO lot_source_type, due_quantity
    FROM production_material_stock_lot
   WHERE id = NEW.lot_id AND production_id = NEW.production_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'material stock lot not found' USING ERRCODE = '23503';
  END IF;
  IF lot_source_type NOT IN ('rented', 'borrowed') THEN
    RAISE EXCEPTION 'only rented or borrowed lots can be returned to source'
      USING ERRCODE = '23514', CONSTRAINT = 'material_source_return_not_required';
  END IF;

  SELECT * INTO movement_record
    FROM production_material_stock_movement
   WHERE id = NEW.movement_id
     AND lot_id = NEW.lot_id
     AND production_id = NEW.production_id;
  IF NOT FOUND
     OR movement_record.from_bucket <> 'in_stock'
     OR movement_record.to_bucket <> 'exited'
     OR movement_record.reverses_event_id IS NOT NULL
     OR movement_record.return_of_movement_id IS NOT NULL
     OR movement_record.occurred_at <> NEW.returned_at
     OR EXISTS (
       SELECT 1 FROM production_material_stock_movement
        WHERE reverses_event_id = movement_record.id
     ) THEN
    RAISE EXCEPTION 'invalid source return movement'
      USING ERRCODE = '23514', CONSTRAINT = 'material_source_return_movement';
  END IF;

  SELECT COALESCE(SUM(m.quantity), 0)
    INTO returned_quantity
    FROM production_material_source_return sr
    JOIN production_material_stock_movement m ON m.id = sr.movement_id
   WHERE sr.lot_id = NEW.lot_id
     AND sr.production_id = NEW.production_id
     AND NOT EXISTS (
       SELECT 1 FROM production_material_stock_movement reverse_movement
        WHERE reverse_movement.reverses_event_id = m.id
     );
  IF returned_quantity + movement_record.quantity > due_quantity THEN
    RAISE EXCEPTION 'source return exceeds due quantity'
      USING ERRCODE = '23514', CONSTRAINT = 'material_source_return_overflow';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER production_material_source_return_guard
BEFORE INSERT ON production_material_source_return
FOR EACH ROW EXECUTE FUNCTION enforce_material_source_return();

CREATE FUNCTION enforce_material_source_exception() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_source_type TEXT;
  material_strategy TEXT;
  material_scale SMALLINT;
  due_quantity NUMERIC(18,3);
  return_lot_id TEXT;
  original_exception production_material_source_exception%ROWTYPE;
BEGIN
  SELECT l.source_type, m.tracking_strategy, m.quantity_scale, l.return_due_quantity
    INTO lot_source_type, material_strategy, material_scale, due_quantity
    FROM production_material_stock_lot l
    JOIN production_material m
      ON m.id = l.material_id AND m.production_id = l.production_id
   WHERE l.id = NEW.lot_id AND l.production_id = NEW.production_id
   FOR UPDATE OF l;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'material stock lot not found' USING ERRCODE = '23503';
  END IF;
  IF lot_source_type NOT IN ('rented', 'borrowed') THEN
    RAISE EXCEPTION 'only rented or borrowed lots can have source exceptions'
      USING ERRCODE = '23514', CONSTRAINT = 'material_source_exception_not_required';
  END IF;
  IF NEW.quantity <> round(NEW.quantity, material_scale) THEN
    RAISE EXCEPTION 'material source exception exceeds configured precision'
      USING ERRCODE = '23514', CONSTRAINT = 'material_quantity_scale';
  END IF;
  IF NEW.quantity > due_quantity THEN
    RAISE EXCEPTION 'material source exception exceeds due quantity'
      USING ERRCODE = '23514', CONSTRAINT = 'material_source_exception_quantity';
  END IF;
  IF material_strategy = 'serialized' AND NEW.quantity <> 1 THEN
    RAISE EXCEPTION 'serialized material source exception quantity must be one'
      USING ERRCODE = '23514', CONSTRAINT = 'material_serialized_movement_quantity';
  END IF;

  IF NEW.source_return_id IS NOT NULL THEN
    SELECT lot_id INTO return_lot_id
      FROM production_material_source_return
     WHERE id = NEW.source_return_id AND production_id = NEW.production_id;
    IF NOT FOUND OR return_lot_id <> NEW.lot_id THEN
      RAISE EXCEPTION 'source exception return does not belong to lot'
        USING ERRCODE = '23514', CONSTRAINT = 'material_source_exception_return';
    END IF;
  END IF;

  IF NEW.resolves_exception_id IS NOT NULL THEN
    SELECT * INTO original_exception
      FROM production_material_source_exception
     WHERE id = NEW.resolves_exception_id
     FOR UPDATE;
    IF NOT FOUND
       OR original_exception.production_id <> NEW.production_id
       OR original_exception.lot_id <> NEW.lot_id
       OR original_exception.resolves_exception_id IS NOT NULL
       OR original_exception.kind <> NEW.kind
       OR original_exception.quantity <> NEW.quantity
       OR NEW.source_return_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid source exception resolution'
        USING ERRCODE = '23514', CONSTRAINT = 'material_source_exception_resolution';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER production_material_source_exception_guard
BEFORE INSERT ON production_material_source_exception
FOR EACH ROW EXECUTE FUNCTION enforce_material_source_exception();

CREATE TRIGGER production_material_source_return_immutable
BEFORE UPDATE OR DELETE ON production_material_source_return
FOR EACH ROW EXECUTE FUNCTION reject_material_stock_history_change();

CREATE TRIGGER production_material_source_exception_immutable
BEFORE UPDATE OR DELETE ON production_material_source_exception
FOR EACH ROW EXECUTE FUNCTION reject_material_stock_history_change();

-- migrate:down

DROP TRIGGER production_material_source_exception_immutable
  ON production_material_source_exception;
DROP TRIGGER production_material_source_return_immutable
  ON production_material_source_return;
DROP TRIGGER production_material_source_exception_guard
  ON production_material_source_exception;
DROP FUNCTION enforce_material_source_exception();
DROP TRIGGER production_material_source_return_guard
  ON production_material_source_return;
DROP FUNCTION enforce_material_source_return();

DROP TABLE production_material_source_exception;
DROP TABLE production_material_source_return;

CREATE OR REPLACE FUNCTION enforce_material_stock_lot_type() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  material_strategy TEXT;
  material_scale SMALLINT;
BEGIN
  SELECT tracking_strategy, quantity_scale
    INTO material_strategy, material_scale
    FROM production_material
   WHERE id = NEW.material_id AND production_id = NEW.production_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'material not found for stock lot' USING ERRCODE = '23503';
  END IF;
  IF NEW.confirmed_quantity <> round(NEW.confirmed_quantity, material_scale) THEN
    RAISE EXCEPTION 'material quantity exceeds configured precision'
      USING ERRCODE = '23514', CONSTRAINT = 'material_quantity_scale';
  END IF;
  IF material_strategy = 'serialized' AND NEW.confirmed_quantity <> 1 THEN
    RAISE EXCEPTION 'serialized material lot quantity must be one'
      USING ERRCODE = '23514', CONSTRAINT = 'material_serialized_lot_quantity';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE production_material_stock_movement DROP COLUMN occurred_at;

ALTER TABLE production_material_stock_lot
  DROP CONSTRAINT material_stock_lot_return_obligation_check,
  DROP CONSTRAINT material_stock_lot_source_type_check,
  DROP COLUMN return_due_quantity,
  DROP COLUMN return_due_at,
  DROP COLUMN expected_arrival_at,
  DROP COLUMN source_note,
  DROP COLUMN source_reference,
  DROP COLUMN source_label,
  DROP COLUMN source_type;
