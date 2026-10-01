-- migrate:up

ALTER TABLE production
  ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'CNY';

ALTER TABLE production_budget_category
  ALTER COLUMN amount TYPE NUMERIC(18,3);

ALTER TABLE production_budget_item
  ALTER COLUMN amount TYPE NUMERIC(18,3),
  ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'CNY',
  ADD COLUMN base_amount NUMERIC(18,3),
  ADD COLUMN exchange_rate NUMERIC(24,12),
  ADD COLUMN exchange_rate_date DATE,
  ADD COLUMN exchange_rate_source TEXT;

ALTER TABLE production_expense
  ALTER COLUMN amount TYPE NUMERIC(18,3),
  ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'CNY',
  ADD COLUMN base_amount NUMERIC(18,3),
  ADD COLUMN exchange_rate NUMERIC(24,12),
  ADD COLUMN exchange_rate_date DATE,
  ADD COLUMN exchange_rate_source TEXT;

-- 存量的 currency 全是 CNY；同币种折算不是市场汇率，不伪造日期和来源。
UPDATE production_budget_item SET base_amount = amount WHERE amount IS NOT NULL;
UPDATE production_expense SET base_amount = amount WHERE status <> 'draft';

ALTER TABLE production
  ADD CONSTRAINT production_base_currency_format_check
  CHECK (base_currency ~ '^[A-Z]{3}$') NOT VALID;

ALTER TABLE production_budget_item
  ADD CONSTRAINT production_budget_item_currency_format_check
  CHECK (currency ~ '^[A-Z]{3}$' AND base_currency ~ '^[A-Z]{3}$') NOT VALID,
  ADD CONSTRAINT production_budget_item_currency_snapshot_check
  CHECK (
    (amount IS NULL AND base_amount IS NULL AND exchange_rate IS NULL
      AND exchange_rate_date IS NULL AND exchange_rate_source IS NULL)
    OR
    (amount IS NOT NULL AND currency = base_currency AND base_amount = amount
      AND exchange_rate IS NULL AND exchange_rate_date IS NULL AND exchange_rate_source IS NULL)
    OR
    (amount IS NOT NULL AND currency <> base_currency AND base_amount IS NOT NULL
      AND base_amount >= 0 AND exchange_rate > 0 AND exchange_rate_date IS NOT NULL
      AND btrim(exchange_rate_source) <> '')
  ) NOT VALID;

ALTER TABLE production_expense
  ADD CONSTRAINT production_expense_currency_format_check
  CHECK (currency ~ '^[A-Z]{3}$' AND base_currency ~ '^[A-Z]{3}$') NOT VALID,
  ADD CONSTRAINT production_expense_currency_snapshot_check
  CHECK (
    (status = 'draft' AND base_amount IS NULL
      AND (exchange_rate IS NULL OR exchange_rate > 0)
      AND (exchange_rate_source IS NULL OR btrim(exchange_rate_source) <> ''))
    OR
    (status <> 'draft' AND amount IS NOT NULL AND currency = base_currency
      AND base_amount = amount AND exchange_rate IS NULL
      AND exchange_rate_date IS NULL AND exchange_rate_source IS NULL)
    OR
    (status <> 'draft' AND amount IS NOT NULL AND currency <> base_currency
      AND base_amount IS NOT NULL AND base_amount >= 0 AND exchange_rate > 0
      AND exchange_rate_date IS NOT NULL AND btrim(exchange_rate_source) <> '')
  ) NOT VALID;

ALTER TABLE production VALIDATE CONSTRAINT production_base_currency_format_check;
ALTER TABLE production_budget_item VALIDATE CONSTRAINT production_budget_item_currency_format_check;
ALTER TABLE production_budget_item VALIDATE CONSTRAINT production_budget_item_currency_snapshot_check;
ALTER TABLE production_expense VALIDATE CONSTRAINT production_expense_currency_format_check;
ALTER TABLE production_expense VALIDATE CONSTRAINT production_expense_currency_snapshot_check;

-- migrate:down

DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
