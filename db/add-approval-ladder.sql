-- #140 审批流升级：把「当前该谁批」持久化到 approval_request 上。
--
-- 此前路由逻辑三处各写一遍（通知分发 / 收件箱 SQL / 鉴权），阶梯扩到五级后
-- 不可能再在 SQL 里重算。现在由 lib/approval-routing.ts 单点算出，写入下列三列：
--   current_stage        当前阶梯级（supervisor/holder/dept_poc/ancestor_poc/producer/owner）
--   current_stage_depth  同级内层深（supervisor 第几跳 / 祖先部门第几层）
--   current_approver_ids 当前级审批人集合（收件箱与鉴权只读这一列）

ALTER TABLE approval_request
  ADD COLUMN IF NOT EXISTS current_stage        TEXT   NULL,
  ADD COLUMN IF NOT EXISTS current_stage_depth  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_approver_ids UUID[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'approval_request_current_stage_check'
      AND table_name = 'approval_request'
  ) THEN
    ALTER TABLE approval_request
      ADD CONSTRAINT approval_request_current_stage_check
      CHECK (current_stage IS NULL OR current_stage IN (
        'supervisor', 'holder', 'dept_poc', 'ancestor_poc', 'producer', 'owner'
      ));
  END IF;
END $$;

-- 收件箱查询恒是「$1 = ANY(current_approver_ids) AND status IN (pending_*)」
CREATE INDEX IF NOT EXISTS approval_request_current_approvers_idx
  ON approval_request USING GIN (current_approver_ids)
  WHERE status IN ('pending_supervisor', 'pending_resource');

-- 存量 pending 行回填：escalation_chain 末条即当时通知的那一级。
-- （已 resolved 的行不回填——current_* 只对 pending 有意义。）
--
-- 旧链只有 supervisor / resource 两种 phase，holder、ancestor_poc、producer
-- 这几级此前并不存在，所以不会有存量行落在它们上面。resource 级的旧人选有
-- POC / 制作人 / owner 三种兜底：审批人恰为 owner 的按 owner 级回填（否则它
-- 会被当成 dept_poc，升级时再把同一个 owner 通知一遍），其余按 dept_poc。
WITH pending AS (
  SELECT ar.id,
         ar.escalation_chain -> -1 ->> 'phase' AS phase,
         p.owner_id,
         COALESCE((
           SELECT array_agg(DISTINCT x::uuid)
           FROM jsonb_array_elements_text(ar.escalation_chain -> -1 -> 'approverIds') AS x
         ), '{}') AS approvers
  FROM approval_request ar
  JOIN production p ON p.id = ar.production_id
  WHERE ar.status IN ('pending_supervisor', 'pending_resource')
    AND ar.current_approver_ids = '{}'
    AND jsonb_typeof(ar.escalation_chain -> -1 -> 'approverIds') = 'array'
)
UPDATE approval_request ar
SET current_stage = CASE
      WHEN pending.phase = 'supervisor'                  THEN 'supervisor'
      WHEN pending.approvers = ARRAY[pending.owner_id]   THEN 'owner'
      ELSE 'dept_poc'
    END,
    current_stage_depth = 0,
    current_approver_ids = pending.approvers
FROM pending
WHERE pending.id = ar.id;
