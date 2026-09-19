-- agents.md 分级注入：制作级 / 个人级指令存储（设计见 MindWeave
-- 《Agents.md 分级注入设计》）。系统级不进表——它是 gateway workspace 的
-- AGENTS.md，repo 版本控制 + CD 同步（openclaw-workspace/），刻意无在线编辑。
--
-- scope_type='user'       scope_id = app_user.id（uuid 文本）
-- scope_type='production' scope_id = production.id（短字母数字串）
-- 两种 scope_id 类型不同，列用 TEXT 不挂 FK；孤儿行无害（注入侧按会话身份查，
-- 用户/制作删除后行自然失联，不参与任何 join）。

CREATE TABLE IF NOT EXISTS agent_instructions (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'production')),
  scope_id   TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  updated_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id)
);
