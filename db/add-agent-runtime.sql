-- #367 AI 运行时自建：会话/transcript/run/审批/提问的持久化（S2 P1）。
--
-- 设计出处：MindWeave《AI运行时自建-薄harness设计》§4.3 / §4.4。
-- 与网关时代的根本差别：会话与 **用户、制作** 的关联是一等列（此前只在 sessionKey
-- 里编码、靠壳反解），会话列表/按制作归档/用量归属/灰度开关都直接按列查。
--
-- transcript 采用 vendor agent-core 的 **append-only 会话树**模型（SessionTreeEntry：
-- message / compaction / leaf / label / …），逐条落行而不是拍平成消息表——
-- 步进级持久化与重启恢复（§4.4 ①）直接建立在它之上；模型上下文由
-- agent-core 按 leaf → root 路径重建，不在 DB 侧解释语义。
--
-- id 规约：新表 TEXT PK + 带随机尾的 short id（lib/agent-runtime/ids.ts）。

-- ── 会话 ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_session (
  id              TEXT        PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- NULL = 个人会话（跨全部制作的 my.* 语义）；非 NULL = 关联制作的会话
  production_id   TEXT        NULL REFERENCES production(id) ON DELETE CASCADE,
  title           TEXT        NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NULL,
  archived_at     TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS agent_session_user_idx
  ON agent_session (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_session_production_idx
  ON agent_session (production_id)
  WHERE production_id IS NOT NULL;

COMMENT ON TABLE agent_session IS
  'AI 会话（#367 自建运行时）。user_id/production_id 是一等列——网关时代只在 sessionKey 里编码。';

-- ── transcript：append-only 会话树条目 ──────────────────────────────────────
-- payload = 完整 SessionTreeEntry JSON（含 id/parentId/timestamp/type 与各类型字段）。
-- entry_id/parent_id/type 抽成列只为查询与约束，语义真相在 payload。
-- seq 是会话内单调追加序，同时是断线重连"since=seq"重放游标。
CREATE TABLE IF NOT EXISTS agent_session_entry (
  session_id  TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  seq         INTEGER     NOT NULL,
  entry_id    TEXT        NOT NULL,
  parent_id   TEXT        NULL,
  type        TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, entry_id)
);

COMMENT ON TABLE agent_session_entry IS
  'agent-core SessionTreeEntry 逐条落行（append-only）。模型上下文由 agent-core 按 leaf→root 重建，DB 不解释语义。';

-- ── run：一轮执行的生命周期与执行者租约 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_run (
  id                TEXT        PRIMARY KEY,
  session_id        TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'awaiting_approval', 'awaiting_answer',
                                        'completed', 'aborted', 'failed', 'interrupted')),
  -- 执行者租约（§4.4）：owner = runner 进程标识；heartbeat_at 每 5s 更新，
  -- 超 30s 无心跳视为孤儿，由存活的 runner 接管恢复。防两个进程同时跑同一 run。
  owner             TEXT        NULL,
  heartbeat_at      TIMESTAMPTZ NULL,
  -- 发起本轮时用户所在页面（PAGE_LABELS 的 pageKey）——温层工具面/知识节点依据
  page_key          TEXT        NULL,
  model             TEXT        NULL,
  input_tokens      INTEGER     NOT NULL DEFAULT 0,
  output_tokens     INTEGER     NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER     NOT NULL DEFAULT 0,
  error             TEXT        NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS agent_run_session_idx
  ON agent_run (session_id, started_at DESC);
-- 孤儿扫描：启动/巡检时找 running 且心跳过期的 run
CREATE INDEX IF NOT EXISTS agent_run_active_idx
  ON agent_run (status, heartbeat_at)
  WHERE status IN ('running', 'awaiting_approval', 'awaiting_answer');

-- ── 审批：写工具的确认门（进程内 await 表状态，重启后从表续）─────────────────
CREATE TABLE IF NOT EXISTS agent_approval (
  id           TEXT        PRIMARY KEY,
  run_id       TEXT        NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  session_id   TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  tool_call_id TEXT        NOT NULL,
  tool         TEXT        NOT NULL,
  args         JSONB       NOT NULL,           -- 全文，不再受网关 512 字符约束
  preview      JSONB       NOT NULL DEFAULT '{}', -- 卡片结构（title/description/severity/hasPermission/反解体…）
  status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
  decision     TEXT        NULL,               -- allow-once / allow-always / deny
  reason       TEXT        NULL,               -- 拒绝理由，回给模型
  resolved_by  UUID        NULL REFERENCES app_user(id) ON DELETE SET NULL,
  -- 批准后工具真正开始执行的时刻：重启恢复时区分"批了没跑"（可跑）与
  -- "跑到一半"（副作用未知，不盲重放）
  executed_at  TIMESTAMPTZ NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS agent_approval_pending_idx
  ON agent_approval (status, expires_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agent_approval_run_idx
  ON agent_approval (run_id);

-- ── ask_user：模型向用户提问（#290 在自建运行时里就是一个 await 的工具）───────
CREATE TABLE IF NOT EXISTS agent_question (
  id           TEXT        PRIMARY KEY,
  run_id       TEXT        NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  session_id   TEXT        NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  tool_call_id TEXT        NOT NULL,
  payload      JSONB       NOT NULL,           -- questions[]（形态对齐 stream-reducer 的 QuestionInfo）
  answer       JSONB       NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'answered', 'cancelled', 'expired')),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS agent_question_pending_idx
  ON agent_question (status, expires_at)
  WHERE status = 'pending';
