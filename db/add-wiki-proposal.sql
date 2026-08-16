-- wiki AI propose staging 表：production.wiki_propose 工具调用的落地凭证。
--
-- 不复用 wiki_revision.origin——wiki_revision 是「已发生的真实内容历史」，
-- 每次 createWiki/updateWiki 无条件落一行，没有「被拒绝/被拦截」状态，也没
-- 有代码按 origin 过滤；propose 在真正 apply 之前需要一个独立的、可以停在
-- pending/blocked/rejected 的暂存位置，供前端按 tool_call_id 拉取完整预览
-- （聊天栏确认卡片 description 硬上限 512 字符，装不下完整 diff/正文）。
--
-- 生命周期：插件 before_tool_call 时预写一行（pending，同时判定当时的
-- has_permission）→ 人类在确认卡片里 allow-once/deny → 若 allow 则
-- production.wiki_propose 工具函数运行时重新查一遍权限（真正的安全边界，
-- 不信任这里预写的 has_permission）→ applied（真建了文档）或
-- blocked_no_permission（无权限，不建）；若 deny 则 rejected。
--
-- 幂等，可重复执行。纯新增，无存量数据语义。

BEGIN;

CREATE TABLE IF NOT EXISTS wiki_proposal (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  tool_call_id    TEXT        NOT NULL,
  proposed_by     UUID        NOT NULL REFERENCES app_user(id),
  parent_wiki_id  UUID        NULL REFERENCES wiki(id) ON DELETE SET NULL,
  title           TEXT        NOT NULL,
  body            TEXT        NOT NULL DEFAULT '',
  summary         TEXT        NOT NULL DEFAULT '',
  has_permission  BOOLEAN     NOT NULL,
  permission_key  TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'applied', 'blocked_no_permission', 'rejected')),
  created_wiki_id UUID        NULL REFERENCES wiki(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ NULL,
  -- 插件 before_tool_call 重试/网关重放同一个 toolCallId 时幂等回填这一行，
  -- 而不是堆出孤儿 pending 行（AI review #249 指出）。
  CONSTRAINT wiki_proposal_production_tool_call_uniq UNIQUE (production_id, tool_call_id)
);

COMMIT;
