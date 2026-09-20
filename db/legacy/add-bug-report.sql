-- db/add-bug-report.sql
-- 依赖：app_user、production 表
-- 用途：「报告问题」入口（#538）的落点。用户拍板：只记 log，开发定期查看后再上 issue，
--       不接 GitHub、不进飞书群。入口两个：产品内头像菜单、手册页底部；只收登录用户。
--
-- 形态：一张只增不改的日志表。status 给开发用（new → triaged → filed / closed），
-- issue_url 是上 issue 之后回填的指针。上下文列（page_path / manual_slug / production_id /
-- user_agent / viewport）由客户端自动带，用户只填 body 与可选联系方式。

CREATE TABLE IF NOT EXISTS bug_report (
  id             TEXT        PRIMARY KEY,               -- br_ 前缀短 id（lib/help/bug-report-db.ts）
  user_id        UUID        NULL REFERENCES app_user(id) ON DELETE SET NULL,
  production_id  TEXT        NULL REFERENCES production(id) ON DELETE SET NULL,
  kind           TEXT        NOT NULL DEFAULT 'bug',    -- bug | manual | suggestion
  body           TEXT        NOT NULL,
  contact        TEXT        NULL,                      -- 用户自填的联系方式（选填）
  page_path      TEXT        NOT NULL,                  -- 提交时所在页面
  manual_slug    TEXT        NULL,                      -- 从手册页提交时的页 slug
  user_agent     TEXT        NULL,
  viewport       TEXT        NULL,                      -- 如 1440x900
  status         TEXT        NOT NULL DEFAULT 'new',    -- new | triaged | filed | closed
  issue_url      TEXT        NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 开发翻看：按状态、最新在前
CREATE INDEX IF NOT EXISTS bug_report_status_idx ON bug_report (status, created_at DESC);
-- 限频：每人每小时 N 条
CREATE INDEX IF NOT EXISTS bug_report_user_time_idx ON bug_report (user_id, created_at DESC);

COMMENT ON TABLE bug_report IS
  '「报告问题」日志（#538）：产品内 / 手册页提交的问题与建议，开发定期查看后上 issue 并回填 issue_url';
