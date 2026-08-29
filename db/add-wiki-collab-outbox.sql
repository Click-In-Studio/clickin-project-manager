-- wiki 协作广播的跨进程出站箱（#367 切换后补齐）。
--
-- lib/wiki-collab.ts 的 SSE 注册表是进程内内存（"单实例 pm2 部署，内存注册表足够"）。
-- AI 运行时独立成 agent-runner 进程后，AI 写文档在 runner 里 broadcast，浏览器的 SSE
-- 连接却挂在 next 进程——广播打进空注册表，页面不再自动刷新。
--
-- 出站箱 + pg_notify('wiki_collab', '<id>:<origin>')：写入方落一行后通知，持有 SSE 的进程
-- LISTEN 后按 id 取帧推给本地客户端；origin 用于跳过自己发的回声。帧走表而不直接塞进
-- NOTIFY 载荷，因为 update 帧带整篇正文，轻易超过 NOTIFY 的 8000 字节上限。
-- 行只需活几分钟（发布时顺手清 5 分钟前的）。

CREATE TABLE IF NOT EXISTS wiki_collab_outbox (
  id         BIGSERIAL   PRIMARY KEY,
  origin     TEXT        NOT NULL,   -- 发布进程标识 host:pid
  topic      TEXT        NOT NULL,   -- wikiId 或 library:<productionId>
  frame      TEXT        NOT NULL,   -- 原样的 SSE 帧文本
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 清理按 created_at 扫（发布路径顺手做，行只活几分钟，但别让它随流量变全表扫）
CREATE INDEX IF NOT EXISTS wiki_collab_outbox_created_idx ON wiki_collab_outbox (created_at);
