-- migrate:up

-- 旧物料表来自 UUID 时代；本模块统一改为应用侧 TEXT short id。当前没有真实物料
-- 数据，仍对 seed / 测试数据做完整保留迁移，避免环境升级依赖清库。
ALTER TABLE production_material ADD COLUMN new_id TEXT;
UPDATE production_material
   SET new_id = 'mt_' || substr(replace(id::text, '-', ''), 1, 16);
ALTER TABLE production_material ALTER COLUMN new_id SET NOT NULL;

DROP TRIGGER production_material_stock_lot_immutable ON production_material_stock_lot;
ALTER TABLE production_material_stock_lot ADD COLUMN new_material_id TEXT;
UPDATE production_material_stock_lot lot
   SET new_material_id = material.new_id
  FROM production_material material
 WHERE material.id = lot.material_id;
ALTER TABLE production_material_stock_lot ALTER COLUMN new_material_id SET NOT NULL;

UPDATE production_member_grant grant_row
   SET resource_id = material.new_id
  FROM production_material material
 WHERE grant_row.production_id = material.production_id
   AND grant_row.resource_type = 'material'
   AND grant_row.resource_id = material.id::text;
UPDATE resource_dept_manage manage_row
   SET resource_id = material.new_id
  FROM production_material material
 WHERE manage_row.production_id = material.production_id
   AND manage_row.resource_type = 'material'
   AND manage_row.resource_id = material.id::text;
UPDATE resource_person_manage manage_row
   SET resource_id = material.new_id
  FROM production_material material
 WHERE manage_row.production_id = material.production_id
   AND manage_row.resource_type = 'material'
   AND manage_row.resource_id = material.id::text;

ALTER TABLE production_material_stock_lot
  DROP CONSTRAINT material_stock_lot_material_fk;
ALTER TABLE production_material
  DROP CONSTRAINT IF EXISTS production_material_id_production_unique,
  DROP CONSTRAINT production_material_pkey;
ALTER TABLE production_material DROP COLUMN id;
ALTER TABLE production_material RENAME COLUMN new_id TO id;
ALTER TABLE production_material ADD PRIMARY KEY (id);
ALTER TABLE production_material
  ADD CONSTRAINT production_material_id_production_unique UNIQUE (id, production_id);

ALTER TABLE production_material_stock_lot DROP COLUMN material_id;
ALTER TABLE production_material_stock_lot RENAME COLUMN new_material_id TO material_id;
ALTER TABLE production_material_stock_lot
  ADD CONSTRAINT material_stock_lot_material_fk
    FOREIGN KEY (material_id, production_id)
    REFERENCES production_material(id, production_id) ON DELETE RESTRICT,
  ADD CONSTRAINT material_stock_lot_id_production_material_unique
    UNIQUE (id, production_id, material_id);
CREATE INDEX production_material_stock_lot_material_idx
  ON production_material_stock_lot (production_id, material_id, created_at);
CREATE TRIGGER production_material_stock_lot_immutable
BEFORE UPDATE OR DELETE ON production_material_stock_lot
FOR EACH ROW EXECUTE FUNCTION reject_material_stock_history_change();

DROP INDEX production_material_code_idx;
ALTER TABLE production_material DROP COLUMN code;

-- 计数器与业务写入同事务更新；回滚不会像 sequence 一样留下未提交的号码洞。
CREATE TABLE production_material_number_counter (
  production_id TEXT PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  last_value    BIGINT NOT NULL CHECK (last_value > 0)
);

CREATE TABLE production_material_stock_code_counter (
  production_id TEXT   NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  material_id   TEXT   NOT NULL,
  code_kind     TEXT   NOT NULL CHECK (code_kind IN ('serialized', 'batch')),
  last_value    BIGINT NOT NULL CHECK (last_value > 0),
  PRIMARY KEY (production_id, material_id, code_kind),
  FOREIGN KEY (material_id, production_id)
    REFERENCES production_material(id, production_id) ON DELETE CASCADE
);

CREATE TABLE production_material_identifier (
  id               TEXT        PRIMARY KEY,
  production_id    TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  material_id      TEXT        NOT NULL,
  lot_id           TEXT,
  kind             TEXT        NOT NULL CHECK (kind IN ('material_number', 'internal_code', 'external')),
  external_type    TEXT        CHECK (external_type IN ('manufacturer_serial', 'source_asset', 'existing_barcode', 'other')),
  external_label   TEXT        NOT NULL DEFAULT '',
  display_value    TEXT        NOT NULL CHECK (btrim(display_value) <> '' AND length(display_value) <= 128),
  normalized_value TEXT        NOT NULL CHECK (btrim(normalized_value) <> '' AND length(normalized_value) <= 128),
  serial_number    BIGINT      CHECK (serial_number > 0),
  token            TEXT        UNIQUE,
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  retired_at       TIMESTAMPTZ,
  retired_by       UUID        REFERENCES app_user(id),
  retired_reason   TEXT        NOT NULL DEFAULT '',
  created_by       UUID        NOT NULL REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT material_identifier_material_fk
    FOREIGN KEY (material_id, production_id)
    REFERENCES production_material(id, production_id) ON DELETE RESTRICT,
  CONSTRAINT material_identifier_lot_fk
    FOREIGN KEY (lot_id, production_id, material_id)
    REFERENCES production_material_stock_lot(id, production_id, material_id) ON DELETE RESTRICT,
  CONSTRAINT material_identifier_shape CHECK (
    (kind = 'material_number' AND lot_id IS NULL AND external_type IS NULL
      AND external_label = '' AND serial_number IS NOT NULL AND token IS NULL)
    OR
    (kind = 'internal_code' AND lot_id IS NOT NULL AND external_type IS NULL
      AND external_label = '' AND serial_number IS NOT NULL AND token IS NOT NULL)
    OR
    (kind = 'external' AND lot_id IS NOT NULL AND external_type IS NOT NULL
      AND serial_number IS NULL AND token IS NULL
      AND (external_type = 'other') = (btrim(external_label) <> ''))
  ),
  CONSTRAINT material_identifier_retired_shape CHECK (
    (is_active AND retired_at IS NULL AND retired_by IS NULL AND retired_reason = '')
    OR
    (NOT is_active AND retired_at IS NOT NULL AND retired_by IS NOT NULL AND btrim(retired_reason) <> '')
  ),
  -- 历史行也占用 normalized_value；失效、换码或退出后都不得静默复用。
  UNIQUE (production_id, normalized_value)
);

CREATE UNIQUE INDEX material_identifier_material_number_idx
  ON production_material_identifier(production_id, material_id)
  WHERE kind = 'material_number';
CREATE UNIQUE INDEX material_identifier_lot_internal_idx
  ON production_material_identifier(production_id, lot_id)
  WHERE kind = 'internal_code' AND is_active;
CREATE INDEX material_identifier_lot_idx
  ON production_material_identifier(production_id, lot_id, created_at);

-- 只在迁移内使用：展示码的 Mod-10 校验位不依赖数据库运行时函数。
CREATE FUNCTION material_identifier_mod10(digits TEXT) RETURNS SMALLINT
LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT ((10 - (SUM(
    substring(digits, position, 1)::int
      * CASE WHEN (length(digits) - position) % 2 = 0 THEN 3 ELSE 1 END
  ) % 10)) % 10)::smallint
  FROM generate_series(1, length(digits)) AS position
$$;

WITH numbered AS (
  SELECT id, production_id, created_by, created_at,
         row_number() OVER (PARTITION BY production_id ORDER BY created_at, id) AS serial
    FROM production_material
)
INSERT INTO production_material_identifier
  (id, production_id, material_id, kind, display_value, normalized_value,
   serial_number, created_by, created_at)
SELECT 'mi_' || substr(md5(production_id || ':' || id || ':material'), 1, 20),
       production_id, id, 'material_number',
       'M-' || lpad(serial::text, 4, '0') || '-' || material_identifier_mod10(serial::text),
       'M' || lpad(serial::text, 4, '0') || material_identifier_mod10(serial::text),
       serial, created_by, created_at
  FROM numbered;

WITH numbered AS (
  SELECT lot.id, lot.production_id, lot.material_id, lot.created_by, lot.created_at,
         material.tracking_strategy,
         row_number() OVER (
           PARTITION BY lot.production_id, lot.material_id
           ORDER BY lot.created_at, lot.id
         ) AS serial,
         material_number.serial_number AS material_serial
    FROM production_material_stock_lot lot
    JOIN production_material material
      ON material.id = lot.material_id AND material.production_id = lot.production_id
    JOIN production_material_identifier material_number
      ON material_number.production_id = lot.production_id
     AND material_number.material_id = lot.material_id
     AND material_number.kind = 'material_number'
), codes AS (
  SELECT *, CASE WHEN tracking_strategy = 'serialized' THEN 'S' ELSE 'B' END AS code_letter,
         material_serial::text || serial::text AS check_digits
    FROM numbered
)
INSERT INTO production_material_identifier
  (id, production_id, material_id, lot_id, kind, display_value, normalized_value,
   serial_number, token, created_by, created_at)
SELECT 'mi_' || substr(md5(production_id || ':' || id || ':internal'), 1, 20),
       production_id, material_id, id, 'internal_code',
       'M-' || lpad(material_serial::text, 4, '0') || '-'
         || code_letter || lpad(serial::text, 3, '0') || '-'
         || material_identifier_mod10(check_digits),
       'M' || lpad(material_serial::text, 4, '0')
         || code_letter || lpad(serial::text, 3, '0')
         || material_identifier_mod10(check_digits),
       serial,
       replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
       created_by, created_at
  FROM codes;

INSERT INTO production_material_number_counter(production_id, last_value)
SELECT production_id, max(serial_number)
  FROM production_material_identifier
 WHERE kind = 'material_number'
 GROUP BY production_id;

INSERT INTO production_material_stock_code_counter
  (production_id, material_id, code_kind, last_value)
SELECT identifier.production_id, identifier.material_id,
       CASE WHEN material.tracking_strategy = 'serialized' THEN 'serialized' ELSE 'batch' END,
       max(identifier.serial_number)
  FROM production_material_identifier identifier
  JOIN production_material material
    ON material.id = identifier.material_id
   AND material.production_id = identifier.production_id
 WHERE identifier.kind = 'internal_code'
 GROUP BY identifier.production_id, identifier.material_id, material.tracking_strategy;

DROP FUNCTION material_identifier_mod10(TEXT);

-- migrate:down

DO $$ BEGIN
  RAISE EXCEPTION 'irreversible: material identifiers replace UUID ids and editable codes';
END $$;
