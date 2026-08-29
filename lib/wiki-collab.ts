/**
 * wiki 多人协作：SSE 注册表 + presence（谁在看/编辑、光标在哪一块）+ 更新广播。
 * 照 server-cache.ts（剧本/cue）同款模式：HMR-safe 全局单例、帧推送、断开清理。
 *
 * 注册表仍是进程内内存，但**内容/结构广播要跨进程**：AI 运行时独立成 agent-runner 后，
 * AI 写文档的 broadcast 发生在 runner 进程，浏览器的 SSE 连接却在 next 进程——不跨就是
 * 打进空注册表（#367 切换后真人校出：写操作后页面不再自动刷新）。做法与 agent_event
 * 同款：帧落 wiki_collab_outbox + pg_notify('wiki_collab', '<id>:<origin>')，持有 SSE 的
 * 进程 LISTEN 后取帧推本地客户端，origin 用于跳过自己的回声。presence 帧只在本进程
 * 有意义（在场者注册表就在这里），不出站。
 */

import { hostname } from "node:os";
import type { Pool, PoolClient } from "pg";
import { getPool } from "@/lib/pg";

export type WikiPeer = {
  clientId: string;
  userId: string;
  userName: string;
  avatarUrl: string | null;
  color: string;
  /** 富文本顶层块索引（光标所在"行"）；null=未上报/阅读中 */
  blockIndex: number | null;
  /** 块内字符偏移（精确光标位；随块内容钳制渲染） */
  offset: number | null;
  updatedAt: number;
};

type SSEPush = (frame: string) => void;

const PEER_COLORS = [
  "#E53E3E", "#DD6B20", "#D69E2E", "#38A169",
  "#3182CE", "#805AD5", "#D53F8C", "#00B5D8",
];

function assignColor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = ((h * 31) + clientId.charCodeAt(i)) & 0xffff;
  return PEER_COLORS[h % PEER_COLORS.length];
}

const g = global as typeof globalThis & {
  __wikiSSERegistry?: Map<string, Map<string, SSEPush>>;
  __wikiPresenceRegistry?: Map<string, Map<string, WikiPeer>>;
};

function sseReg(): Map<string, Map<string, SSEPush>> {
  if (!g.__wikiSSERegistry) g.__wikiSSERegistry = new Map();
  return g.__wikiSSERegistry;
}
function presReg(): Map<string, Map<string, WikiPeer>> {
  if (!g.__wikiPresenceRegistry) g.__wikiPresenceRegistry = new Map();
  return g.__wikiPresenceRegistry;
}

const STALE_MS = 90_000;

function livePeers(wikiId: string): WikiPeer[] {
  const m = presReg().get(wikiId);
  if (!m) return [];
  const now = Date.now();
  for (const [cid, p] of m) if (now - p.updatedAt > STALE_MS) m.delete(cid);
  return [...m.values()];
}

function localBroadcast(topic: string, frame: string): void {
  const clients = sseReg().get(topic);
  if (!clients) return;
  for (const push of clients.values()) {
    try { push(frame); } catch { /* broken pipe */ }
  }
}

/** 本进程推 + 出站给其他进程（失败只记日志：广播是增强项，不能拖垮写库路径） */
function broadcast(topic: string, frame: string): void {
  localBroadcast(topic, frame);
  void publishRemote(topic, frame).catch((err) => console.error("[wiki-collab] publish failed:", err));
}

// ─── 跨进程 ──────────────────────────────────────────────────────────────────

export const COLLAB_CHANNEL = "wiki_collab";
/** 本进程标识：回声过滤用 */
export const COLLAB_ORIGIN = `${hostname()}:${process.pid}`;

async function publishRemote(topic: string, frame: string, pool: Pool = getPool()): Promise<void> {
  await pool.query(
    `WITH ins AS (
       INSERT INTO wiki_collab_outbox (origin, topic, frame) VALUES ($1, $2, $3) RETURNING id
     ), gc AS (
       DELETE FROM wiki_collab_outbox WHERE created_at < now() - interval '5 minutes'
     )
     SELECT pg_notify($4, ins.id::text || ':' || $1) FROM ins`,
    [COLLAB_ORIGIN, topic, frame, COLLAB_CHANNEL],
  );
}

/**
 * 进程级 LISTEN 单例：第一个 SSE 客户端注册时才连（runner 没有客户端就永远不连）。
 * 断连后置空，下次注册时重连——期间错过的帧不补：协作帧是"现在发生了什么"，
 * 客户端有自己的兜底（AgentPopout 的 tool-end 刷新、重开文档）。
 */
class CollabListener {
  private client: PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  constructor(private readonly pool: Pool) {}

  async ensure(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = await this.pool.connect();
      client.on("notification", (msg) => {
        if (msg.channel !== COLLAB_CHANNEL || !msg.payload) return;
        const idx = msg.payload.indexOf(":");
        const id = msg.payload.slice(0, idx);
        const origin = msg.payload.slice(idx + 1);
        if (origin === COLLAB_ORIGIN) return; // 自己发的，本地已经推过
        void this.pool.query<{ topic: string; frame: string }>(`SELECT topic, frame FROM wiki_collab_outbox WHERE id = $1`, [id])
          .then((r) => { if (r.rows[0]) localBroadcast(r.rows[0].topic, r.rows[0].frame); })
          .catch((err) => console.error("[wiki-collab] fetch frame failed:", err));
      });
      client.on("error", () => { this.client = null; });
      await client.query(`LISTEN ${COLLAB_CHANNEL}`);
      this.client = client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) { try { await c.query(`UNLISTEN ${COLLAB_CHANNEL}`); } catch { /* ignore */ } c.release(); }
  }
}

const gl = global as typeof globalThis & { __wikiCollabListener?: CollabListener };

function ensureCollabListener(): void {
  if (!gl.__wikiCollabListener) gl.__wikiCollabListener = new CollabListener(getPool());
  void gl.__wikiCollabListener.ensure().catch((err) => console.error("[wiki-collab] LISTEN failed:", err));
}

/** 测试用：断开 LISTEN 连接（否则连接池关不掉） */
export async function stopCollabListenerForTests(): Promise<void> {
  await gl.__wikiCollabListener?.stop();
}

export function wikiPresenceFrame(wikiId: string): string {
  return `event: presence\ndata: ${JSON.stringify(livePeers(wikiId))}\n\n`;
}

export function registerWikiSSE(
  wikiId: string,
  connectionId: string,
  push: SSEPush,
): () => void {
  ensureCollabListener(); // 有客户端的进程才需要收别的进程的帧
  let m = sseReg().get(wikiId);
  if (!m) { m = new Map(); sseReg().set(wikiId, m); }
  m.set(connectionId, push);
  return () => {
    const reg = sseReg().get(wikiId);
    reg?.delete(connectionId);
    if (reg && reg.size === 0) sseReg().delete(wikiId);
  };
}

export function updateWikiPresence(
  wikiId: string,
  clientId: string,
  info: { userId: string; userName: string; avatarUrl: string | null },
  cursor: { blockIndex: number; offset: number } | null,
): void {
  let m = presReg().get(wikiId);
  if (!m) { m = new Map(); presReg().set(wikiId, m); }
  m.set(clientId, {
    clientId,
    userId: info.userId,
    userName: info.userName,
    avatarUrl: info.avatarUrl,
    color: assignColor(clientId),
    blockIndex: cursor?.blockIndex ?? null,
    offset: cursor?.offset ?? null,
    updatedAt: Date.now(),
  });
  localBroadcast(wikiId, wikiPresenceFrame(wikiId));
}

export function removeWikiPresence(wikiId: string, clientId: string): void {
  const m = presReg().get(wikiId);
  if (!m) return;
  m.delete(clientId);
  if (m.size === 0) presReg().delete(wikiId);
  localBroadcast(wikiId, wikiPresenceFrame(wikiId));
}

/** 内容/标题/标签更新广播（byClientId 供发起端自过滤） */
export function broadcastWikiUpdate(
  wikiId: string,
  payload: {
    byClientId: string | null; title: string | null; body: string; updatedAt: string;
    /** 省略=标签未变（老帧形态），接收端不动本地标签。 */
    tags?: string[];
  },
): void {
  broadcast(wikiId, `event: update\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ─── 文档库级频道 ────────────────────────────────────────────────────────────
// 结构变化（增/删/改名/移动/换标签）影响的是**别的**文档的页面：左侧树、
// 以及"我正开着的这篇被删了"。这类事件不值得单开一条 SSE——同一个注册表
// 里挂一个按 production 分组的 topic，文档 stream 路由顺带订阅它，客户端
// 仍然只有一条 EventSource。
//
// topic 键与 wikiId 不可能相撞：wikiId 是 UUID，这里恒带 "library:" 前缀。

function libraryTopic(productionId: string): string {
  return `library:${productionId}`;
}

export type WikiLibraryChange = {
  kind: "created" | "updated" | "deleted";
  wikiId: string;
};

/** 文档 SSE 连接顺带订阅所属制作的库级频道（返回退订）。 */
export function registerWikiLibrarySSE(
  productionId: string,
  connectionId: string,
  push: SSEPush,
): () => void {
  return registerWikiSSE(libraryTopic(productionId), connectionId, push);
}

export function broadcastWikiLibraryChange(productionId: string, payload: WikiLibraryChange): void {
  broadcast(libraryTopic(productionId), `event: library\ndata: ${JSON.stringify(payload)}\n\n`);
}
