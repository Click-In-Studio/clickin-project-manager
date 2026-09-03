-- 审批流程模版存储层（prA）。设计：docs/approval-flow-template-design-2026-09-03.md。
-- 只存不驱动：执行引擎（prB）落地前，published 仅是「使用中」声明标记。
-- 节点结构校验在 lib/approval-flow-template.ts 的运行时白名单（服务端 create/update 必经），
-- DB 侧只押结构无关的硬约束。

CREATE TABLE IF NOT EXISTS approval_flow_template (
  id             TEXT        PRIMARY KEY,          -- aft_ 前缀 short id（仓库 id 规约）
  production_id  TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description    TEXT        NOT NULL DEFAULT '',
  resource_scope TEXT        NOT NULL DEFAULT '',  -- v1 展示字符串；范围匹配语义归 prB
  status         TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  nodes          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     UUID        NULL REFERENCES app_user(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_flow_template_production
  ON approval_flow_template (production_id);

-- 单一使用中：编译器语义「该项目有已发布模版？」是单数（设计文档 §3）。
-- publish 动作在事务内先降旧再升新，此索引兜并发竞态的底。
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_flow_template_published
  ON approval_flow_template (production_id) WHERE status = 'published';
