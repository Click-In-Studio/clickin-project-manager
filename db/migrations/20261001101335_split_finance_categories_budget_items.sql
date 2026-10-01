-- migrate:up

CREATE UNIQUE INDEX IF NOT EXISTS production_dept_id_production_idx
  ON production_dept (id, production_id);

CREATE TABLE production_expense_category (
  id            TEXT        PRIMARY KEY,
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  description   TEXT        NOT NULL DEFAULT '',
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, production_id),
  UNIQUE (production_id, name)
);

CREATE INDEX production_expense_category_production_idx
  ON production_expense_category (production_id, sort_order, name);

CREATE TABLE production_budget_item (
  id                 TEXT          PRIMARY KEY,
  production_id      TEXT          NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  category_id        TEXT          NOT NULL,
  dept_id            UUID,
  amount             NUMERIC(14,2) CHECK (amount IS NULL OR amount >= 0),
  currency           TEXT          NOT NULL DEFAULT 'CNY',
  notes              TEXT          NOT NULL DEFAULT '',
  sort_order         INTEGER       NOT NULL DEFAULT 0,
  legacy_category_id UUID          UNIQUE REFERENCES production_budget_category(id) ON DELETE RESTRICT,
  created_by         UUID          NOT NULL REFERENCES app_user(id),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (id, production_id),
  FOREIGN KEY (category_id, production_id)
    REFERENCES production_expense_category(id, production_id) ON DELETE CASCADE,
  FOREIGN KEY (dept_id, production_id)
    REFERENCES production_dept(id, production_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX production_budget_item_dept_unique_idx
  ON production_budget_item (production_id, category_id, dept_id)
  WHERE dept_id IS NOT NULL;
CREATE UNIQUE INDEX production_budget_item_public_unique_idx
  ON production_budget_item (production_id, category_id)
  WHERE dept_id IS NULL;
CREATE INDEX production_budget_item_production_idx
  ON production_budget_item (production_id, dept_id, sort_order, id);

ALTER TABLE production_expense
  ADD COLUMN budget_item_id TEXT REFERENCES production_budget_item(id) ON DELETE SET NULL;
CREATE INDEX pe_budget_item_idx ON production_expense (budget_item_id)
  WHERE budget_item_id IS NOT NULL;

INSERT INTO production_expense_category
  (id, production_id, name, description, sort_order, created_by, created_at, updated_at)
SELECT 'ec_' || replace(id::text, '-', ''), production_id, name, '', order_index,
       created_by, created_at, updated_at
  FROM production_budget_category;

INSERT INTO production_budget_item
  (id, production_id, category_id, dept_id, amount, currency, notes, sort_order,
   legacy_category_id, created_by, created_at, updated_at)
SELECT 'bi_' || replace(id::text, '-', ''), production_id,
       'ec_' || replace(id::text, '-', ''), dept_id,
       CASE WHEN amount = 0 THEN NULL ELSE amount END,
       currency, notes, order_index, id, created_by, created_at, updated_at
  FROM production_budget_category;

UPDATE production_expense e
   SET budget_item_id = bi.id
  FROM production_budget_item bi
 WHERE e.category_id = bi.legacy_category_id;

UPDATE resource_dept_manage rdm
   SET resource_id = bi.id
  FROM production_budget_item bi
 WHERE rdm.resource_type = 'finance'
   AND rdm.resource_id = bi.legacy_category_id::text;

UPDATE production_member_grant pmg
   SET resource_id = bi.id
  FROM production_budget_item bi
 WHERE pmg.resource_type = 'finance'
   AND pmg.resource_id = bi.legacy_category_id::text;

UPDATE resource_person_manage rpm
   SET resource_id = bi.id
  FROM production_budget_item bi
 WHERE rpm.resource_type = 'finance'
   AND rpm.resource_id = bi.legacy_category_id::text;

UPDATE production_role_permission prp
   SET permission_key = replace(prp.permission_key,
     'node:finance/' || bi.legacy_category_id::text || '/', 'node:finance/' || bi.id || '/')
  FROM production_role pr, production_budget_item bi
 WHERE pr.id = prp.role_id
   AND pr.production_id = bi.production_id
   AND prp.permission_key LIKE 'node:finance/' || bi.legacy_category_id::text || '/%';

UPDATE production_member_permission pmp
   SET permission = replace(pmp.permission,
     'node:finance/' || bi.legacy_category_id::text || '/', 'node:finance/' || bi.id || '/')
  FROM production_budget_item bi
 WHERE pmp.production_id = bi.production_id
   AND pmp.permission LIKE 'node:finance/' || bi.legacy_category_id::text || '/%';

UPDATE production_dept_permission pdp
   SET permission_key = replace(pdp.permission_key,
     'node:finance/' || bi.legacy_category_id::text || '/', 'node:finance/' || bi.id || '/')
  FROM production_budget_item bi
 WHERE pdp.production_id = bi.production_id
   AND pdp.permission_key LIKE 'node:finance/' || bi.legacy_category_id::text || '/%';

-- migrate:down

DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
