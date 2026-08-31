-- AI 写操作的 diff 审计（2026-08-30 定谳，见 lib/agent-runtime/mutation-audit.ts）。
--
-- 每一次由 AI 工具落地的写都记一行：谁的哪次 run、哪个工具、动了哪个域的哪个实体、
-- 写前 / 写后快照与字段级变化。它是**纯只读账本**——没有 reverted_* 列，撤销永远是
-- 人自己的动作（甲的定时任务把 A 改成 B、乙又改成 C、甲回头一键撤回 = 冲突，机器
-- 不该替人合并）。diff 把「AI 改了什么」说清楚，人自己决定要不要动、怎么动。
--
-- 为什么 run/session 是 SET NULL 而不是 CASCADE：账本要比会话活得久——用户删掉一段
-- 聊天不该让共享文档上的一次 AI 修改从项目审计里消失。人（user_id）与制作
-- （production_id）没了才随之消失。
--
-- 快照形态由域决定（scope 读取器）：wiki 存 revision id 引用不复制正文（正文历史已在
-- wiki_revision），其余域存精简字段。changes 是给人看的字段级变化列表，通知 / 会话卡 /
-- 审计页都从它渲染。
--
-- id 规约：新表 TEXT PK + 带随机尾的 short id（lib/agent-runtime/ids.ts）。

CREATE TABLE IF NOT EXISTS agent_mutation (
  id            TEXT        PRIMARY KEY,
  run_id        TEXT        NULL REFERENCES agent_run(id) ON DELETE SET NULL,
  session_id    TEXT        NULL REFERENCES agent_session(id) ON DELETE SET NULL,
  user_id       UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  production_id TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  tool          TEXT        NOT NULL,           -- 注册表 mcpName（production.wiki_propose_update 等）
  tool_call_id  TEXT        NOT NULL,
  scope         TEXT        NOT NULL,           -- 与 mutates 声明同源：wiki / scene / character / instructions.*
  entity_id     TEXT        NULL,               -- 实体 id；域级变更（无具体实体）为 NULL
  action        TEXT        NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  label         TEXT        NULL,               -- 实体的人话名（标题/名称），渲染用，随快照一起定格
  summary       TEXT        NULL,               -- 模型在参数里给的一句话意图（args.summary）
  before        JSONB       NULL,               -- 写前快照（created 为 NULL）
  after         JSONB       NULL,               -- 写后快照（deleted 为 NULL）
  changes       JSONB       NOT NULL DEFAULT '[]', -- [{field, from?, to?, added?, removed?}]
  unattended    BOOLEAN     NOT NULL DEFAULT false, -- 无人值守（定时任务）写的
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_mutation_production_idx
  ON agent_mutation (production_id, created_at DESC)
  WHERE production_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_mutation_user_idx
  ON agent_mutation (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_mutation_run_idx
  ON agent_mutation (run_id)
  WHERE run_id IS NOT NULL;

COMMENT ON TABLE agent_mutation IS
  'AI 写操作的 diff 审计（只读账本，无撤销列）。每次写工具真正改了东西才落行；before/after 由域读取器定形。';
