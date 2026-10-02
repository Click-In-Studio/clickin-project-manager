-- migrate:up

-- 物料本体只描述“是什么”；确认会入库的数量从批次开始，之后所有变化只记追加流水。
ALTER TABLE production_material
  ADD CONSTRAINT production_material_id_production_unique UNIQUE (id, production_id);

CREATE TABLE production_material_stock_lot (
  id                 TEXT          PRIMARY KEY,
  production_id      TEXT          NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  material_id        UUID          NOT NULL,
  confirmed_quantity NUMERIC(18,3) NOT NULL CHECK (confirmed_quantity > 0),
  location           TEXT          NOT NULL DEFAULT '',
  created_by         UUID          NOT NULL REFERENCES app_user(id),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT material_stock_lot_material_fk
    FOREIGN KEY (material_id, production_id)
    REFERENCES production_material(id, production_id) ON DELETE RESTRICT,
  CONSTRAINT material_stock_lot_id_production_unique UNIQUE (id, production_id)
);

CREATE INDEX production_material_stock_lot_material_idx
  ON production_material_stock_lot (production_id, material_id, created_at);

CREATE TABLE production_material_stock_movement (
  id                TEXT          PRIMARY KEY,
  production_id     TEXT          NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  lot_id            TEXT          NOT NULL,
  from_bucket       TEXT          NOT NULL CHECK (from_bucket IN ('expected', 'in_stock', 'checked_out', 'maintenance', 'exited')),
  to_bucket         TEXT          NOT NULL CHECK (to_bucket IN ('expected', 'in_stock', 'checked_out', 'maintenance', 'exited')),
  quantity          NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  reverses_event_id TEXT          REFERENCES production_material_stock_movement(id) ON DELETE RESTRICT,
  note              TEXT          NOT NULL DEFAULT '',
  created_by        UUID          NOT NULL REFERENCES app_user(id),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT material_stock_movement_distinct_buckets CHECK (from_bucket <> to_bucket),
  CONSTRAINT material_stock_movement_lot_fk
    FOREIGN KEY (lot_id, production_id)
    REFERENCES production_material_stock_lot(id, production_id) ON DELETE RESTRICT,
  CONSTRAINT material_stock_movement_single_reversal UNIQUE (reverses_event_id)
);

CREATE INDEX production_material_stock_movement_lot_idx
  ON production_material_stock_movement (lot_id, created_at, id);

CREATE FUNCTION enforce_material_stock_movement() RETURNS trigger
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

CREATE TRIGGER production_material_stock_movement_guard
BEFORE INSERT ON production_material_stock_movement
FOR EACH ROW EXECUTE FUNCTION enforce_material_stock_movement();

CREATE FUNCTION reject_material_stock_history_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 删除整个项目时允许外键级联清理；项目内的历史不得覆盖或硬删。
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM production WHERE id = OLD.production_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'material stock history is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER production_material_stock_lot_immutable
BEFORE UPDATE OR DELETE ON production_material_stock_lot
FOR EACH ROW EXECUTE FUNCTION reject_material_stock_history_change();

CREATE TRIGGER production_material_stock_movement_immutable
BEFORE UPDATE OR DELETE ON production_material_stock_movement
FOR EACH ROW EXECUTE FUNCTION reject_material_stock_history_change();

-- 保留已有事实：旧行都是已经登记的现有库存，因此转换为一个已收货批次。
INSERT INTO production_material_stock_lot
  (id, production_id, material_id, confirmed_quantity, location, created_by, created_at)
SELECT 'ml_' || replace(id::text, '-', ''), production_id, id, quantity, location, created_by, created_at
  FROM production_material
 WHERE quantity > 0;

INSERT INTO production_material_stock_movement
  (id, production_id, lot_id, from_bucket, to_bucket, quantity, note, created_by, created_at)
SELECT 'mm_' || replace(id::text, '-', ''), production_id,
       'ml_' || replace(id::text, '-', ''), 'expected', 'in_stock', quantity,
       '由旧物料台账迁移', created_by, created_at
  FROM production_material
 WHERE quantity > 0;

ALTER TABLE production_material DROP COLUMN quantity;
ALTER TABLE production_material DROP COLUMN location;

-- migrate:down

DO $$ BEGIN
  RAISE EXCEPTION 'irreversible: material stock ledger replaces legacy quantity and location';
END $$;
