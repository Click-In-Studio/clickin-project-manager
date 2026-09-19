-- 审批流程模版引擎（prB）：approval_request 增流程实例快照列。
-- 设计：docs/approval-flow-template-design-2026-09-03.md §3/§4。
--
-- flow_snapshot 两段式快照的「结构」段：提交时定格的节点序列与规则 + 各节点状态。
-- NULL = 阶梯流（存量行与无模版项目的新申请）——引擎对 NULL 走原封不动的既有
-- 阶梯路径，这就是懒编译：不回填任何存量行。
-- flow_template_id 只作引用审计（哪个模版编译的）；语义真相在快照里，模版删除
-- 不影响在途行（SET NULL）。

ALTER TABLE approval_request
  ADD COLUMN IF NOT EXISTS flow_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS flow_template_id TEXT NULL
    REFERENCES approval_flow_template(id) ON DELETE SET NULL;
