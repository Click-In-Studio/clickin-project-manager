-- 财务：预算科目 + 支出记录。
--
-- ## 不是 sensitive 域（2026-08-20 用户定谳）
--
-- 制作人批财务本来就是制作人的核心工作；大剧组有财务岗也能批；有的剧组 PSM/SM 能看
-- 预算，甚至设计人员能看（好决定自己的设计放到哪个 budget level）。所以财务的可见性
-- 是**按面配置**的，不是一刀切的敏感域——`isSensitiveNode` 不加 finance。
--
-- 这条直接决定了审批链：sensitive 会跳过整条链直达 owner（那报销就只有老板能批），
-- normal 才走完整阶梯，而完整阶梯里「制作人」那一级天然就是财务审批人。
--
-- ## 审批复用路由，不复用表（2026-08-20 用户定谳：「流程是一致的，未必要完全一套表」）
--
-- 审批人由 lib/approval-routing.ts 的 buildApprovalLadder 算，与权限申请同一个函数：
--   直属上级链 → 资源持有者 → 共管部门 POC → 父部门 POC → 制作人 → owner
-- 支出的 target 表达成 `finance/<科目id>/expenses`，于是「共管部门 POC」那一级自动
-- 变成「这个预算科目归哪个部门管」——建科目时往 resource_dept_manage 写一行即可，
-- 不用教路由认识预算科目。财务岗同理：把财务部门挂到 `finance/*` 上就成为一级。
--
-- 状态字段名与 approval_request 刻意保持一致（current_stage / current_approver_ids /
-- escalation_chain），这样收件箱把两边并起来时是同构的。**但表是分开的**——
-- approval_request 的批准动作会发权限行，支出批准绝不能发。
--
-- ## 金额与币种
--
-- NUMERIC(14,2) 不用浮点。currency 现在恒 'CNY'，但**必须现在就有这一列**：
-- 事后补币种会让存量行的金额含义变成不可判定（巡演到境外那天再加就晚了）。

BEGIN;

-- ── 预算科目 ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_budget_category (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT          NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name          TEXT          NOT NULL,
  amount        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency      TEXT          NOT NULL DEFAULT 'CNY',
  /** 归属部门。写这一列的同时会往 resource_dept_manage 写一行，
   *  该部门的 POC 由此成为本科目支出的审批人之一。 */
  dept_id       UUID          REFERENCES production_dept(id) ON DELETE SET NULL,
  order_index   INTEGER       NOT NULL DEFAULT 0,
  notes         TEXT          NOT NULL DEFAULT '',
  created_by    UUID          NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pbc_name_idx
  ON production_budget_category (production_id, name);
CREATE INDEX IF NOT EXISTS pbc_production_idx
  ON production_budget_category (production_id);

-- ── 支出 ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_expense (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT          NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  -- 科目被删不连坐删支出，落成「未归科目」
  category_id   UUID          REFERENCES production_budget_category(id) ON DELETE SET NULL,
  title         TEXT          NOT NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency      TEXT          NOT NULL DEFAULT 'CNY',
  note          TEXT          NOT NULL DEFAULT '',
  submitted_by  UUID          NOT NULL REFERENCES app_user(id),

  status        TEXT          NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),

  -- 审批位置。字段名与 approval_request 一致，好让收件箱两边同构；
  -- 值由 buildApprovalLadder 算出后写死在这里，收件箱与鉴权只读它，不各自重算
  -- （approval_request 那边写过三遍改一处漏两处的教训，#140）。
  current_stage        TEXT    NULL CHECK (current_stage IS NULL OR current_stage IN (
                         'supervisor', 'holder', 'dept_poc', 'ancestor_poc', 'producer', 'owner'
                       )),
  current_stage_depth  INTEGER NOT NULL DEFAULT 0,
  current_approver_ids UUID[]  NOT NULL DEFAULT '{}',
  escalation_chain     JSONB   NOT NULL DEFAULT '[]',

  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID          REFERENCES app_user(id),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pe_production_idx ON production_expense (production_id);
CREATE INDEX IF NOT EXISTS pe_category_idx   ON production_expense (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pe_approver_idx   ON production_expense USING GIN (current_approver_ids);
CREATE INDEX IF NOT EXISTS pe_pending_idx    ON production_expense (production_id, status) WHERE status = 'pending';

COMMIT;
