-- migrate:up

ALTER TABLE production_expense
  DROP CONSTRAINT production_expense_status_check;

ALTER TABLE production_expense
  ALTER COLUMN title SET DEFAULT '',
  ALTER COLUMN amount DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'draft',
  ADD COLUMN mutation_seq BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN submitted_at TIMESTAMPTZ;

UPDATE production_expense
   SET status = 'withdrawn'
 WHERE status = 'cancelled';

UPDATE production_expense
   SET submitted_at = created_at
 WHERE submitted_at IS NULL;

ALTER TABLE production_expense
  DROP CONSTRAINT production_expense_invoice_waiver_reason_check,
  ADD CONSTRAINT production_expense_status_check
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'withdrawn')) NOT VALID,
  ADD CONSTRAINT production_expense_submitted_content_check
    CHECK (
      status = 'draft'
      OR (btrim(title) <> '' AND amount IS NOT NULL AND submitted_at IS NOT NULL)
    ) NOT VALID,
  ADD CONSTRAINT production_expense_invoice_waiver_reason_check
    CHECK (status = 'draft' OR invoice_requirement <> 'waived' OR btrim(invoice_waiver_reason) <> '') NOT VALID;

ALTER TABLE production_expense
  VALIDATE CONSTRAINT production_expense_status_check;
ALTER TABLE production_expense
  VALIDATE CONSTRAINT production_expense_submitted_content_check;
ALTER TABLE production_expense
  VALIDATE CONSTRAINT production_expense_invoice_waiver_reason_check;

CREATE TABLE production_expense_event (
  id            TEXT        PRIMARY KEY,
  expense_id    UUID        NOT NULL REFERENCES production_expense(id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL CHECK (event_type IN (
                  'draft_created', 'draft_saved', 'submitted', 'forwarded',
                  'approved', 'rejected', 'withdrawn', 'reopened',
                  'document_added', 'document_removed', 'post_approval_document_added'
                )),
  actor_id      UUID        REFERENCES app_user(id),
  comment       TEXT,
  mutation_seq  BIGINT      NOT NULL,
  details       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX production_expense_event_expense_idx
  ON production_expense_event(expense_id, created_at, id);

-- 存量报销没有显式提交事件；用原始创建时刻建立最小但真实的起点。
INSERT INTO production_expense_event
  (id, expense_id, event_type, actor_id, mutation_seq, details, created_at)
SELECT 'eevt_' || md5(e.id::text || ':submitted'), e.id, 'submitted', e.submitted_by, 0,
       jsonb_build_object(
         'legacy', true,
         'title', e.title,
         'amount', e.amount::text,
         'currency', e.currency,
         'categoryId', e.category_id,
         'evidenceAssetFileIds', COALESCE((
           SELECT jsonb_agg(d.asset_file_id ORDER BY d.created_at, d.id)
             FROM production_expense_document d
            WHERE d.expense_id = e.id
         ), '[]'::jsonb)
       ),
       e.created_at
  FROM production_expense e;

-- 阶梯里已经落过的真实动作转成持久事件；无动作的末级仍只是当前路由状态。
INSERT INTO production_expense_event
  (id, expense_id, event_type, actor_id, comment, mutation_seq, details, created_at)
SELECT 'eevt_' || md5(e.id::text || ':chain:' || item.ordinality::text),
       e.id,
       CASE item.entry ->> 'action'
         WHEN 'approved' THEN 'approved'
         WHEN 'rejected' THEN 'rejected'
         WHEN 'cancelled' THEN 'withdrawn'
         ELSE 'forwarded'
       END,
       NULLIF(item.entry ->> 'actorId', '')::uuid,
       NULLIF(item.entry ->> 'comment', ''),
       0,
       item.entry,
       COALESCE((item.entry ->> 'actedAt')::timestamptz, e.created_at)
  FROM production_expense e
 CROSS JOIN LATERAL jsonb_array_elements(e.escalation_chain)
   WITH ORDINALITY AS item(entry, ordinality)
 WHERE item.entry ? 'action';

-- 旧实现的终局批准/驳回/撤回没有完整写进 escalation_chain，以列事实补齐。
INSERT INTO production_expense_event
  (id, expense_id, event_type, actor_id, mutation_seq, details, created_at)
SELECT 'eevt_' || md5(e.id::text || ':terminal'),
       e.id,
       CASE e.status
         WHEN 'approved' THEN 'approved'
         WHEN 'rejected' THEN 'rejected'
         ELSE 'withdrawn'
       END,
       COALESCE(e.resolved_by, CASE WHEN e.status = 'withdrawn' THEN e.submitted_by END),
       0,
       jsonb_build_object('legacy', true),
       COALESCE(e.resolved_at, e.updated_at)
  FROM production_expense e
 WHERE e.status IN ('approved', 'rejected', 'withdrawn')
   AND NOT EXISTS (
     SELECT 1
       FROM production_expense_event ev
      WHERE ev.expense_id = e.id
        AND ev.event_type = CASE e.status
          WHEN 'approved' THEN 'approved'
          WHEN 'rejected' THEN 'rejected'
          ELSE 'withdrawn'
        END
   );


-- migrate:down

DO $$
BEGIN
  RAISE EXCEPTION 'irreversible: expense lifecycle migration rewrites status values and backfills audit events';
END $$;
