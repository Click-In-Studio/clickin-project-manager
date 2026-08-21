-- Agent 记忆检索索引（M1 检索地基）。
-- 设计出处：MindWeave《OpenClaw记忆检索机制调研与移植设计》——搬机制不搬引擎：
-- OpenClaw builtin 引擎的 chunk/provenance/recall-metadata 三表在 Postgres 重建，
-- 多租户边界从「一 agent 一 SQLite 文件」换成 scope 谓词列。
--
-- 版本约束：服务器 pgvector 是 Ubuntu 24.04 打包的 0.6.0（本地 brew 0.8.6）——
-- 本文件只用 0.6 兼容面（vector 类型 + HNSW + cosine ops），不用 halfvec/
-- sparsevec/迭代扫描等 0.7+ 特性。
--
-- 维度钉死 1024（DashScope text-embedding-v4 / Qwen3-Embedding，MRL 截断）。
-- 换 embedding 模型或维度 = 索引身份变化：不做在线迁移，走「暂停向量通路 +
-- 显式重建」（agent_memory_index_meta 与运行时配置不一致时向量车道拒绝服务，
-- 由回填脚本重建后更新 meta）。
--
-- 幂等，可重复执行。纯新增，无存量数据语义。

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- ── 记忆块（对应 OpenClaw memory_index_chunks + recall_metadata + provenance 合表）──
--
-- 三表合一的理由：OpenClaw 拆表是因为 recall_metadata/provenance 是后加的
-- （可空列 + 旧索引零迁移）；我们全新建表，没有历史包袱，合表省两次 JOIN。
-- 「provenance 是模型经 prose 写不到的列」这条安全属性由写入路径保证（只有
-- 索引器代码写这些列，没有任何 MCP 工具暴露写入口），与拆不拆表无关。
CREATE TABLE IF NOT EXISTS agent_memory_chunk (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 多租户边界：一切查询强制带 scope 谓词。scope_id 多态（user=app_user
  -- UUID 文本 / production=uid() 短串），故无 FK；清理由归属方生命周期驱动。
  scope_type     TEXT        NOT NULL CHECK (scope_type IN ('user', 'production')),
  scope_id       TEXT        NOT NULL,
  -- curated=蒸馏产物 MEMORY.md 切块（常青，不衰减）；episodic=runs.jsonl
  -- 逐条（30 天半衰期）。episodic 永不自动注入是安全属性，检索工具可见。
  source         TEXT        NOT NULL CHECK (source IN ('curated', 'episodic')),
  text           TEXT        NOT NULL,
  -- 关键词车道语料：CJK 逐对 bigram + ASCII 整词（空格分隔，索引器生成）。
  -- 不用 pg_trgm：实测 word_similarity 对连续中文近乎失效（短查询串的
  -- trigram 边界填充在无空格文本上对不上，「张三」对含张三的句子=0 分）；
  -- bigram 切词是中文检索标准做法，也与 OpenClaw FTS5 的 CJK n-gram
  -- tokenizer 同思路。评分=查询 bigram 命中占比（0..1 天然归一）。
  text_tokens    TEXT        NOT NULL,
  -- 内容 hash（sha256 hex）：幂等键 + embedding 缓存键。
  content_hash   TEXT        NOT NULL,
  -- 生成该 embedding 的模型；NULL = 嵌入尚未完成（供应商挂掉时仍索引文本，
  -- 关键词车道可用，向量车道跳过——对应 OpenClaw creation-time fallback）。
  model          TEXT        NULL,
  embedding      vector(1024) NULL,
  -- 召回元数据（对应 recall_metadata；可空=中性，M2 蒸馏升级后才开始产出）
  importance     SMALLINT    NULL CHECK (importance IS NULL OR importance BETWEEN 1 AND 10),
  triggers       TEXT        NULL,
  -- provenance（对应 chunk_provenance；只有索引器写，无任何工具暴露写入口）
  origin_class   TEXT        NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
  session_kind   TEXT        NOT NULL CHECK (session_kind IN ('interactive', 'cron', 'heartbeat', 'subagent', 'unknown')),
  observed_at    TIMESTAMPTZ NOT NULL,
  supersedes_key TEXT        NULL,
  -- production 域多作者记账（user 域恒等于 scope_id，冗余但统一查询面）
  author_user_id UUID        NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 幂等：同 scope 同 source 下同内容只存一份（也是防召回回环的一半——
  -- 同一事实被反复上报仍是一行）
  UNIQUE (scope_type, scope_id, source, content_hash)
);

-- 向量车道：HNSW + cosine（0.6.0 起可用）。语料量级小（每 scope 千行级），
-- 默认参数足够。
CREATE INDEX IF NOT EXISTS agent_memory_chunk_embedding_idx
  ON agent_memory_chunk USING hnsw (embedding vector_cosine_ops);

-- 关键词车道无专用索引：评分是逐查询 bigram 的 LIKE 命中占比，在 scope
-- 谓词过滤后的行集（每用户千行级）上顺扫，量级内无索引必要。
CREATE INDEX IF NOT EXISTS agent_memory_chunk_scope_idx
  ON agent_memory_chunk (scope_type, scope_id, source);

-- ── embedding 缓存（对应 OpenClaw embedding cache 表）────────────────────────
-- curated 重建是「整 scope 删了重插」，没有缓存的话每次蒸馏都全量重嵌；
-- 按 (model, content_hash) 查重后未变更的行零 API 调用。
CREATE TABLE IF NOT EXISTS agent_memory_embedding_cache (
  model        TEXT         NOT NULL,
  content_hash TEXT         NOT NULL,
  embedding    vector(1024) NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (model, content_hash)
);

-- ── 索引身份（对应 OpenClaw index identity）──────────────────────────────────
-- 运行时配置的 (model, dim) 与此不一致 → 向量车道拒绝服务并要求显式重建，
-- 绝不静默混维度。单行表。
CREATE TABLE IF NOT EXISTS agent_memory_index_meta (
  id         SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model      TEXT        NOT NULL,
  dim        INTEGER     NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 召回记账（Phase B 晋升门的确定性信号源）─────────────────────────────────
-- memory_search 每次命中记一行：召回频次/查询多样性是 OpenClaw deep 阶段
-- 确定性门的头两个加权信号，从 M1 就开始攒。
CREATE TABLE IF NOT EXISTS agent_memory_recall_log (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chunk_id   UUID        NOT NULL REFERENCES agent_memory_chunk(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL,
  query_hash TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_memory_recall_log_chunk_idx
  ON agent_memory_recall_log (chunk_id, created_at);

-- ── AI 用量账本（内部核算 + 失控告警；未来转嫁定价的数据地基）────────────────
-- embedding 与 chat 共用一张表，按 kind 区分。M1 只接 embedding 两个 kind，
-- chat 侧接入另行处理。
CREATE TABLE IF NOT EXISTS ai_usage (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       UUID        NULL,
  production_id TEXT        NULL,
  kind          TEXT        NOT NULL,
  model         TEXT        NOT NULL,
  tokens        INTEGER     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_created_idx ON ai_usage (created_at);

COMMIT;
