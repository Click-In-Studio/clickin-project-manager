-- migrate:up
-- event/task/经手对象的 id 是历史快照定位信息，不是树边或授权边；删除实体不抹掉事实。
ALTER TABLE production_material_stock_movement
  DROP CONSTRAINT production_material_stock_movement_from_bucket_check,
  DROP CONSTRAINT production_material_stock_movement_to_bucket_check,
  ADD CONSTRAINT production_material_stock_movement_from_bucket_check
    CHECK (from_bucket IN ('expected','in_stock','checked_out','maintenance','exited','cancelled','adjustment')),
  ADD CONSTRAINT production_material_stock_movement_to_bucket_check
    CHECK (to_bucket IN ('expected','in_stock','checked_out','maintenance','exited','cancelled','adjustment')),
  ADD COLUMN operation TEXT NOT NULL DEFAULT '',
  ADD COLUMN reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN exit_reason TEXT CHECK (exit_reason IN ('lost','sold','scrapped','returned_to_source','other')),
  ADD COLUMN from_location TEXT NOT NULL DEFAULT '',
  ADD COLUMN to_location TEXT NOT NULL DEFAULT '',
  ADD COLUMN event_id TEXT,
  ADD COLUMN event_title TEXT NOT NULL DEFAULT '',
  ADD COLUMN task_id TEXT,
  ADD COLUMN task_title TEXT NOT NULL DEFAULT '',
  ADD COLUMN custodian_kind TEXT CHECK (custodian_kind IN ('user','dept','group','event')),
  ADD COLUMN custodian_id TEXT,
  ADD COLUMN custodian_label TEXT NOT NULL DEFAULT '',
  ADD COLUMN source_before NUMERIC(18,3),
  ADD COLUMN source_after NUMERIC(18,3),
  ADD COLUMN target_before NUMERIC(18,3),
  ADD COLUMN target_after NUMERIC(18,3),
  ADD CONSTRAINT material_custodian_pair CHECK ((custodian_kind IS NULL) = (custodian_id IS NULL));

CREATE INDEX material_stock_use_event_idx ON production_material_stock_movement(production_id,event_id)
  WHERE event_id IS NOT NULL;
CREATE INDEX material_stock_use_task_idx ON production_material_stock_movement(production_id,task_id)
  WHERE task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_material_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot production_material_stock_lot%ROWTYPE;
  strategy TEXT;
  original production_material_stock_movement%ROWTYPE;
  task_event TEXT;
  label TEXT;
BEGIN
  SELECT * INTO lot FROM production_material_stock_lot
    WHERE id=NEW.lot_id AND production_id=NEW.production_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'material stock lot not found' USING ERRCODE='23503';
  END IF;
  SELECT tracking_strategy INTO strategy FROM production_material WHERE id=lot.material_id;

  IF NEW.reverses_event_id IS NOT NULL THEN
    NEW.operation := 'reversal';
    SELECT * INTO original FROM production_material_stock_movement WHERE id=NEW.reverses_event_id;
    IF original.reverses_event_id IS NOT NULL OR btrim(NEW.reason)='' OR EXISTS (
      SELECT 1 FROM production_material_stock_movement r
      WHERE r.return_of_movement_id=original.id AND NOT EXISTS (
        SELECT 1 FROM production_material_stock_movement rv WHERE rv.reverses_event_id=r.id
      )
    ) THEN
      RAISE EXCEPTION 'reversal requires reason and unreconciled original'
        USING ERRCODE='23514', CONSTRAINT='material_lifecycle_reversal';
    END IF;
    NEW.event_id:=original.event_id; NEW.event_title:=original.event_title;
    NEW.task_id:=original.task_id; NEW.task_title:=original.task_title;
    NEW.custodian_kind:=original.custodian_kind; NEW.custodian_id:=original.custodian_id;
    NEW.custodian_label:=original.custodian_label;
    NEW.from_location:=original.to_location; NEW.to_location:=original.from_location;
    NEW.exit_reason:=original.exit_reason;
  ELSE
    NEW.operation := CASE
      WHEN NEW.from_bucket='expected' AND NEW.to_bucket='in_stock' THEN 'receipt'
      WHEN NEW.from_bucket='expected' AND NEW.to_bucket='cancelled' THEN 'cancel'
      WHEN NEW.from_bucket='in_stock' AND NEW.to_bucket='checked_out' THEN 'checkout'
      WHEN NEW.from_bucket='checked_out' AND NEW.to_bucket='in_stock' THEN 'return'
      WHEN NEW.from_bucket IN ('in_stock','checked_out') AND NEW.to_bucket='maintenance' THEN 'maintenance'
      WHEN NEW.from_bucket='maintenance' AND NEW.to_bucket='in_stock' THEN 'repair'
      WHEN NEW.from_bucket IN ('in_stock','checked_out','maintenance') AND NEW.to_bucket='exited' THEN 'exit'
      WHEN NEW.from_bucket='adjustment' AND NEW.to_bucket='in_stock' THEN 'adjustment'
      WHEN NEW.from_bucket='in_stock' AND NEW.to_bucket='adjustment' THEN 'adjustment'
      ELSE NULL END;
    IF NEW.operation IS NULL OR (strategy='consumable' AND NEW.operation IN ('maintenance','repair'))
       OR (strategy='serialized' AND NEW.operation='adjustment') THEN
      RAISE EXCEPTION 'illegal material transition'
        USING ERRCODE='23514', CONSTRAINT='material_lifecycle_transition';
    END IF;
    IF NEW.operation IN ('exit','cancel','maintenance','adjustment') AND btrim(NEW.reason)='' THEN
      RAISE EXCEPTION 'material movement requires reason'
        USING ERRCODE='23514', CONSTRAINT='material_lifecycle_reason';
    END IF;
    IF (NEW.operation='exit') <> (NEW.exit_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'exit reason only valid for exit'
        USING ERRCODE='23514', CONSTRAINT='material_lifecycle_reason';
    END IF;
    IF NEW.exit_reason='returned_to_source' AND NEW.from_bucket<>'in_stock' THEN
      RAISE EXCEPTION 'source return must be in stock'
        USING ERRCODE='23514', CONSTRAINT='material_lifecycle_transition';
    END IF;

    IF NEW.return_of_movement_id IS NOT NULL THEN
      SELECT * INTO original FROM production_material_stock_movement WHERE id=NEW.return_of_movement_id;
      IF (NEW.event_id IS NOT NULL AND NEW.event_id IS DISTINCT FROM original.event_id)
         OR (NEW.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM original.task_id) THEN
        RAISE EXCEPTION 'return use must match checkout'
          USING ERRCODE='23514', CONSTRAINT='material_lifecycle_use';
      END IF;
      NEW.event_id:=original.event_id; NEW.event_title:=original.event_title;
      NEW.task_id:=original.task_id; NEW.task_title:=original.task_title;
      IF NEW.from_location='' THEN NEW.from_location:=original.to_location; END IF;
      IF NEW.to_location='' AND NEW.to_bucket='in_stock' THEN NEW.to_location:=original.from_location; END IF;
    ELSIF NEW.event_id IS NOT NULL OR NEW.task_id IS NOT NULL THEN
      IF NEW.operation<>'checkout' THEN
        RAISE EXCEPTION 'use links belong to checkout'
          USING ERRCODE='23514', CONSTRAINT='material_lifecycle_use';
      END IF;
      IF NEW.event_id IS NOT NULL THEN
        SELECT title INTO label FROM production_event WHERE id=NEW.event_id AND production_id=NEW.production_id FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'invalid event use' USING ERRCODE='23514', CONSTRAINT='material_lifecycle_use';
        END IF;
        NEW.event_title:=label;
      END IF;
      IF NEW.task_id IS NOT NULL THEN
        SELECT title,event_id INTO label,task_event FROM task WHERE id=NEW.task_id AND production_id=NEW.production_id FOR SHARE;
        IF NOT FOUND OR (task_event IS NOT NULL AND NEW.event_id IS NOT NULL AND task_event<>NEW.event_id) THEN
          RAISE EXCEPTION 'invalid task use' USING ERRCODE='23514', CONSTRAINT='material_lifecycle_use';
        END IF;
        NEW.task_title:=label;
      END IF;
    END IF;

    IF NEW.custodian_kind IS NOT NULL THEN
      CASE NEW.custodian_kind
        WHEN 'user' THEN SELECT COALESCE(NULLIF(p.display_name,''),p.name,'') INTO label FROM production_member m
          LEFT JOIN user_profile p ON p.user_id=m.user_id
          WHERE m.production_id=NEW.production_id AND m.user_id::text=NEW.custodian_id AND m.status='active';
        WHEN 'dept' THEN SELECT name INTO label FROM production_dept
          WHERE production_id=NEW.production_id AND id::text=NEW.custodian_id;
        WHEN 'group' THEN SELECT name INTO label FROM event_group
          WHERE production_id=NEW.production_id AND id::text=NEW.custodian_id;
        WHEN 'event' THEN SELECT title INTO label FROM production_event
          WHERE production_id=NEW.production_id AND id=NEW.custodian_id;
        ELSE RAISE EXCEPTION 'invalid custodian' USING ERRCODE='23514', CONSTRAINT='material_lifecycle_custodian';
      END CASE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid custodian' USING ERRCODE='23514', CONSTRAINT='material_lifecycle_custodian';
      END IF;
      NEW.custodian_label:=label;
    END IF;
  END IF;

  SELECT (CASE WHEN NEW.from_bucket='expected' THEN lot.confirmed_quantity ELSE 0 END)
    + COALESCE(SUM(CASE WHEN to_bucket=NEW.from_bucket THEN quantity WHEN from_bucket=NEW.from_bucket THEN -quantity ELSE 0 END),0),
    (CASE WHEN NEW.to_bucket='expected' THEN lot.confirmed_quantity ELSE 0 END)
    + COALESCE(SUM(CASE WHEN to_bucket=NEW.to_bucket THEN quantity WHEN from_bucket=NEW.to_bucket THEN -quantity ELSE 0 END),0)
    INTO NEW.source_before,NEW.target_before FROM production_material_stock_movement WHERE lot_id=NEW.lot_id;
  NEW.source_after:=NEW.source_before-NEW.quantity;
  NEW.target_after:=NEW.target_before+NEW.quantity;
  IF NEW.operation='receipt' AND NEW.to_location='' THEN NEW.to_location:=lot.location; END IF;
  IF NEW.exit_reason='returned_to_source' AND NEW.to_location='' THEN NEW.to_location:=lot.source_label; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER production_material_a_lifecycle_guard
  BEFORE INSERT ON production_material_stock_movement
  FOR EACH ROW EXECUTE FUNCTION enforce_material_lifecycle();


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

  IF NEW.from_bucket <> 'adjustment' AND available_quantity < NEW.quantity THEN
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

  IF NEW.from_bucket = 'checked_out' AND NEW.to_bucket IN ('in_stock','maintenance','exited')
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
       OR NEW.to_bucket NOT IN ('in_stock','maintenance','exited')
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

CREATE OR REPLACE FUNCTION enforce_material_effective_obligation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot production_material_stock_lot%ROWTYPE;
  cancelled NUMERIC(18,3);
  returned NUMERIC(18,3);
  missing NUMERIC(18,3);
  extra NUMERIC(18,3) := 0;
  movement production_material_stock_movement%ROWTYPE;
BEGIN
  SELECT * INTO lot FROM production_material_stock_lot WHERE id=NEW.lot_id FOR UPDATE;
  IF lot.return_due_quantity IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(CASE WHEN to_bucket='cancelled' THEN quantity
    WHEN from_bucket='cancelled' THEN -quantity ELSE 0 END),0)
    INTO cancelled FROM production_material_stock_movement WHERE lot_id=lot.id;
  SELECT COALESCE(SUM(m.quantity),0) INTO returned FROM production_material_source_return sr
    JOIN production_material_stock_movement m ON m.id=sr.movement_id
    WHERE sr.lot_id=lot.id AND NOT EXISTS (SELECT 1 FROM production_material_stock_movement rv WHERE rv.reverses_event_id=m.id);
  SELECT COALESCE(SUM(e.quantity),0) INTO missing FROM production_material_source_exception e
    WHERE e.lot_id=lot.id AND e.kind IN ('lost','short') AND e.resolves_exception_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM production_material_source_exception r WHERE r.resolves_exception_id=e.id)
      AND (e.source_return_id IS NULL OR EXISTS (
        SELECT 1 FROM production_material_source_return sr WHERE sr.id=e.source_return_id
          AND NOT EXISTS (SELECT 1 FROM production_material_stock_movement rv WHERE rv.reverses_event_id=sr.movement_id)));
  IF TG_TABLE_NAME='production_material_stock_movement' THEN
    IF NEW.to_bucket='cancelled' THEN cancelled:=cancelled+NEW.quantity;
    ELSIF NEW.from_bucket='cancelled' THEN cancelled:=cancelled-NEW.quantity;
    ELSE RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='production_material_source_return' THEN
    SELECT * INTO movement FROM production_material_stock_movement WHERE id=NEW.movement_id;
    IF movement.operation<>'' AND movement.exit_reason IS DISTINCT FROM 'returned_to_source' THEN
      RAISE EXCEPTION 'invalid source return reason' USING ERRCODE='23514', CONSTRAINT='material_source_return_movement';
    END IF;
    extra:=movement.quantity;
  ELSE
    IF NEW.resolves_exception_id IS NOT NULL OR NEW.kind='damaged' THEN RETURN NEW; END IF;
    extra:=NEW.quantity;
  END IF;
  IF returned+missing+extra>LEAST(lot.return_due_quantity,lot.confirmed_quantity-cancelled) THEN
    IF TG_TABLE_NAME='production_material_source_exception' THEN
      RAISE EXCEPTION 'source exception exceeds uncancelled quantity'
        USING ERRCODE='23514', CONSTRAINT='material_source_exception_quantity';
    END IF;
    RAISE EXCEPTION 'source obligation exceeds uncancelled quantity'
      USING ERRCODE='23514', CONSTRAINT='material_source_return_overflow';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER material_effective_obligation_guard BEFORE INSERT ON production_material_stock_movement
  FOR EACH ROW EXECUTE FUNCTION enforce_material_effective_obligation();
CREATE TRIGGER material_effective_obligation_guard BEFORE INSERT ON production_material_source_return
  FOR EACH ROW EXECUTE FUNCTION enforce_material_effective_obligation();
CREATE TRIGGER material_effective_obligation_guard BEFORE INSERT ON production_material_source_exception
  FOR EACH ROW EXECUTE FUNCTION enforce_material_effective_obligation();

CREATE OR REPLACE FUNCTION enforce_material_source_exit_pair() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.exit_reason='returned_to_source' AND NEW.reverses_event_id IS NULL
    AND EXISTS (SELECT 1 FROM production_material_stock_lot WHERE id=NEW.lot_id AND source_type IN ('rented','borrowed'))
    AND NOT EXISTS (SELECT 1 FROM production_material_source_return WHERE movement_id=NEW.id) THEN
    RAISE EXCEPTION 'source exit requires source return ledger'
      USING ERRCODE='23514', CONSTRAINT='material_source_return_movement';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER material_source_exit_pair_guard AFTER INSERT ON production_material_stock_movement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_material_source_exit_pair();

-- migrate:down
DROP TRIGGER material_source_exit_pair_guard ON production_material_stock_movement;
DROP FUNCTION enforce_material_source_exit_pair();
DROP TRIGGER material_effective_obligation_guard ON production_material_stock_movement;
DROP TRIGGER material_effective_obligation_guard ON production_material_source_return;
DROP TRIGGER material_effective_obligation_guard ON production_material_source_exception;
DROP FUNCTION enforce_material_effective_obligation();
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
DROP TRIGGER production_material_a_lifecycle_guard ON production_material_stock_movement;
DROP FUNCTION enforce_material_lifecycle();
DROP INDEX material_stock_use_event_idx;
DROP INDEX material_stock_use_task_idx;
ALTER TABLE production_material_stock_movement
  DROP CONSTRAINT material_custodian_pair,
  DROP COLUMN operation, DROP COLUMN reason, DROP COLUMN exit_reason,
  DROP COLUMN from_location, DROP COLUMN to_location,
  DROP COLUMN event_id, DROP COLUMN event_title, DROP COLUMN task_id, DROP COLUMN task_title,
  DROP COLUMN custodian_kind, DROP COLUMN custodian_id, DROP COLUMN custodian_label,
  DROP COLUMN source_before, DROP COLUMN source_after, DROP COLUMN target_before, DROP COLUMN target_after,
  DROP CONSTRAINT production_material_stock_movement_from_bucket_check,
  DROP CONSTRAINT production_material_stock_movement_to_bucket_check,
  ADD CONSTRAINT production_material_stock_movement_from_bucket_check
    CHECK (from_bucket IN ('expected','in_stock','checked_out','maintenance','exited')),
  ADD CONSTRAINT production_material_stock_movement_to_bucket_check
    CHECK (to_bucket IN ('expected','in_stock','checked_out','maintenance','exited'));
