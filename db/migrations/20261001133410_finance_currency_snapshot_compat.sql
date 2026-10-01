-- migrate:up

-- expand 阶段：N-1 代码还不会写本位币列。对同本位币写入在库内补出确定性快照；
-- 外币仍必须由 N 代码提供人工汇率，不能静默伪造。
CREATE FUNCTION fill_budget_currency_snapshot_compat()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_base_currency TEXT;
BEGIN
  SELECT base_currency INTO project_base_currency FROM production WHERE id = NEW.production_id;
  IF NEW.amount IS NULL THEN
    NEW.base_currency := project_base_currency;
    NEW.base_amount := NULL;
    NEW.exchange_rate := NULL;
    NEW.exchange_rate_date := NULL;
    NEW.exchange_rate_source := NULL;
  ELSIF NEW.currency = project_base_currency AND NEW.exchange_rate IS NULL THEN
    NEW.base_currency := project_base_currency;
    NEW.base_amount := NEW.amount;
    NEW.exchange_rate_date := NULL;
    NEW.exchange_rate_source := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER production_budget_item_currency_snapshot_compat
BEFORE INSERT OR UPDATE OF amount, currency, base_currency, base_amount,
  exchange_rate, exchange_rate_date, exchange_rate_source
ON production_budget_item
FOR EACH ROW EXECUTE FUNCTION fill_budget_currency_snapshot_compat();

CREATE FUNCTION fill_expense_currency_snapshot_compat()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_base_currency TEXT;
BEGIN
  SELECT base_currency INTO project_base_currency FROM production WHERE id = NEW.production_id;
  IF NEW.status = 'draft' THEN
    NEW.base_amount := NULL;
    IF NEW.currency = project_base_currency AND NEW.exchange_rate IS NULL THEN
      NEW.base_currency := project_base_currency;
      NEW.exchange_rate_date := NULL;
      NEW.exchange_rate_source := NULL;
    END IF;
  ELSIF NEW.currency = project_base_currency AND NEW.exchange_rate IS NULL THEN
    NEW.base_currency := project_base_currency;
    NEW.base_amount := NEW.amount;
    NEW.exchange_rate_date := NULL;
    NEW.exchange_rate_source := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER production_expense_currency_snapshot_compat
BEFORE INSERT OR UPDATE OF amount, currency, status, base_currency, base_amount,
  exchange_rate, exchange_rate_date, exchange_rate_source
ON production_expense
FOR EACH ROW EXECUTE FUNCTION fill_expense_currency_snapshot_compat();

-- migrate:down

DROP TRIGGER production_expense_currency_snapshot_compat ON production_expense;
DROP FUNCTION fill_expense_currency_snapshot_compat();
DROP TRIGGER production_budget_item_currency_snapshot_compat ON production_budget_item;
DROP FUNCTION fill_budget_currency_snapshot_compat();
