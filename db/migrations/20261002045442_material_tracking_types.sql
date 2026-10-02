-- migrate:up

ALTER TABLE production_material
  ADD COLUMN tracking_strategy TEXT NOT NULL DEFAULT 'bulk_returnable',
  ADD COLUMN unit TEXT NOT NULL DEFAULT '件',
  ADD COLUMN quantity_scale SMALLINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT production_material_tracking_strategy_check
    CHECK (tracking_strategy IN ('serialized', 'bulk_returnable', 'consumable')),
  ADD CONSTRAINT production_material_unit_check CHECK (btrim(unit) <> ''),
  ADD CONSTRAINT production_material_quantity_scale_check CHECK (quantity_scale BETWEEN 0 AND 3),
  ADD CONSTRAINT production_material_serialized_scale_check
    CHECK (tracking_strategy <> 'serialized' OR quantity_scale = 0);

ALTER TABLE production_material_stock_movement
  ADD COLUMN return_of_movement_id TEXT
    REFERENCES production_material_stock_movement(id) ON DELETE RESTRICT,
  ADD CONSTRAINT material_stock_movement_single_reference
    CHECK (num_nonnulls(reverses_event_id, return_of_movement_id) <= 1);

CREATE INDEX production_material_stock_movement_return_idx
  ON production_material_stock_movement (return_of_movement_id)
  WHERE return_of_movement_id IS NOT NULL;

CREATE FUNCTION guard_material_tracking_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tracking_strategy, NEW.unit, NEW.quantity_scale)
       IS DISTINCT FROM (OLD.tracking_strategy, OLD.unit, OLD.quantity_scale)
     AND EXISTS (
       SELECT 1 FROM production_material_stock_lot
        WHERE material_id = OLD.id AND production_id = OLD.production_id
     ) THEN
    RAISE EXCEPTION 'material tracking fields cannot change after inventory exists'
      USING ERRCODE = '23514', CONSTRAINT = 'material_tracking_has_history';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER production_material_tracking_immutable
BEFORE UPDATE OF tracking_strategy, unit, quantity_scale ON production_material
FOR EACH ROW EXECUTE FUNCTION guard_material_tracking_change();

CREATE FUNCTION enforce_material_stock_lot_type() RETURNS trigger
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

CREATE TRIGGER production_material_stock_lot_type_guard
BEFORE INSERT ON production_material_stock_lot
FOR EACH ROW EXECUTE FUNCTION enforce_material_stock_lot_type();

CREATE OR REPLACE FUNCTION enforce_material_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_quantity NUMERIC(18,3);
  available_quantity NUMERIC(18,3);
  returned_quantity NUMERIC(18,3);
  material_strategy TEXT;
  material_scale SMALLINT;
  reversed_event production_material_stock_movement%ROWTYPE;
  checkout_event production_material_stock_movement%ROWTYPE;
BEGIN
  SELECT l.confirmed_quantity, m.tracking_strategy, m.quantity_scale
    INTO lot_quantity, material_strategy, material_scale
    FROM production_material_stock_lot l
    JOIN production_material m
      ON m.id = l.material_id AND m.production_id = l.production_id
   WHERE l.id = NEW.lot_id AND l.production_id = NEW.production_id
   FOR UPDATE OF l;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'material stock lot not found' USING ERRCODE = '23503';
  END IF;

  IF NEW.quantity <> round(NEW.quantity, material_scale) THEN
    RAISE EXCEPTION 'material movement exceeds configured precision'
      USING ERRCODE = '23514', CONSTRAINT = 'material_quantity_scale';
  END IF;
  IF material_strategy = 'serialized' AND NEW.quantity <> 1 THEN
    RAISE EXCEPTION 'serialized material movement quantity must be one'
      USING ERRCODE = '23514', CONSTRAINT = 'material_serialized_movement_quantity';
  END IF;

  SELECT (CASE WHEN NEW.from_bucket = 'expected' THEN lot_quantity ELSE 0 END)
       + COALESCE(SUM(CASE WHEN to_bucket = NEW.from_bucket THEN quantity ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN from_bucket = NEW.from_bucket THEN quantity ELSE 0 END), 0)
    INTO available_quantity
    FROM production_material_stock_movement
   WHERE lot_id = NEW.lot_id;

  IF available_quantity < NEW.quantity THEN
    RAISE EXCEPTION 'material stock would become negative'
      USING ERRCODE = '23514', CONSTRAINT = 'material_stock_nonnegative';
  END IF;

  IF NEW.reverses_event_id IS NOT NULL THEN
    SELECT * INTO reversed_event
      FROM production_material_stock_movement
     WHERE id = NEW.reverses_event_id;
    IF NOT FOUND
       OR reversed_event.lot_id <> NEW.lot_id
       OR reversed_event.from_bucket <> NEW.to_bucket
       OR reversed_event.to_bucket <> NEW.from_bucket
       OR reversed_event.quantity <> NEW.quantity THEN
      RAISE EXCEPTION 'invalid material stock reversal'
        USING ERRCODE = '23514', CONSTRAINT = 'material_stock_exact_reversal';
    END IF;
  END IF;

  IF NEW.from_bucket = 'checked_out' AND NEW.to_bucket = 'in_stock'
     AND NEW.reverses_event_id IS NULL AND NEW.return_of_movement_id IS NULL THEN
    RAISE EXCEPTION 'material return must reference its checkout'
      USING ERRCODE = '23514', CONSTRAINT = 'material_stock_return_reference_required';
  END IF;

  IF NEW.return_of_movement_id IS NOT NULL THEN
    SELECT * INTO checkout_event
      FROM production_material_stock_movement
     WHERE id = NEW.return_of_movement_id;
    IF NOT FOUND
       OR checkout_event.lot_id <> NEW.lot_id
       OR checkout_event.from_bucket <> 'in_stock'
       OR checkout_event.to_bucket <> 'checked_out'
       OR checkout_event.reverses_event_id IS NOT NULL
       OR checkout_event.return_of_movement_id IS NOT NULL
       OR NEW.from_bucket <> 'checked_out'
       OR NEW.to_bucket <> 'in_stock'
       OR EXISTS (
         SELECT 1 FROM production_material_stock_movement
          WHERE reverses_event_id = checkout_event.id
       ) THEN
      RAISE EXCEPTION 'invalid material stock return reference'
        USING ERRCODE = '23514', CONSTRAINT = 'material_stock_valid_return';
    END IF;

    SELECT COALESCE(SUM(r.quantity), 0) - COALESCE(SUM(rv.quantity), 0)
      INTO returned_quantity
      FROM production_material_stock_movement r
      LEFT JOIN production_material_stock_movement rv ON rv.reverses_event_id = r.id
     WHERE r.return_of_movement_id = checkout_event.id;
    IF returned_quantity + NEW.quantity > checkout_event.quantity THEN
      RAISE EXCEPTION 'material return exceeds checkout quantity'
        USING ERRCODE = '23514', CONSTRAINT = 'material_stock_return_overflow';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down

CREATE OR REPLACE FUNCTION enforce_material_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_quantity NUMERIC(18,3);
  available_quantity NUMERIC(18,3);
  reversed_event production_material_stock_movement%ROWTYPE;
BEGIN
  -- 同一批次串行校验；并发签出不能同时读到同一份余额。
  SELECT confirmed_quantity INTO lot_quantity
    FROM production_material_stock_lot
   WHERE id = NEW.lot_id AND production_id = NEW.production_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'material stock lot not found' USING ERRCODE = '23503';
  END IF;

  SELECT (CASE WHEN NEW.from_bucket = 'expected' THEN lot_quantity ELSE 0 END)
       + COALESCE(SUM(CASE WHEN to_bucket = NEW.from_bucket THEN quantity ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN from_bucket = NEW.from_bucket THEN quantity ELSE 0 END), 0)
    INTO available_quantity
    FROM production_material_stock_movement
   WHERE lot_id = NEW.lot_id;

  IF available_quantity < NEW.quantity THEN
    RAISE EXCEPTION 'material stock would become negative'
      USING ERRCODE = '23514', CONSTRAINT = 'material_stock_nonnegative';
  END IF;

  IF NEW.reverses_event_id IS NOT NULL THEN
    SELECT * INTO reversed_event
      FROM production_material_stock_movement
     WHERE id = NEW.reverses_event_id;
    IF NOT FOUND
       OR reversed_event.lot_id <> NEW.lot_id
       OR reversed_event.from_bucket <> NEW.to_bucket
       OR reversed_event.to_bucket <> NEW.from_bucket
       OR reversed_event.quantity <> NEW.quantity THEN
      RAISE EXCEPTION 'invalid material stock reversal'
        USING ERRCODE = '23514', CONSTRAINT = 'material_stock_exact_reversal';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER production_material_stock_lot_type_guard ON production_material_stock_lot;
DROP FUNCTION enforce_material_stock_lot_type();
DROP TRIGGER production_material_tracking_immutable ON production_material;
DROP FUNCTION guard_material_tracking_change();
DROP INDEX production_material_stock_movement_return_idx;
ALTER TABLE production_material_stock_movement
  DROP CONSTRAINT material_stock_movement_single_reference,
  DROP COLUMN return_of_movement_id;
ALTER TABLE production_material
  DROP CONSTRAINT production_material_serialized_scale_check,
  DROP CONSTRAINT production_material_quantity_scale_check,
  DROP CONSTRAINT production_material_unit_check,
  DROP CONSTRAINT production_material_tracking_strategy_check,
  DROP COLUMN quantity_scale,
  DROP COLUMN unit,
  DROP COLUMN tracking_strategy;
