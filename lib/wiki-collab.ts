/**
 * wiki 多人协作：SSE 注册表 + presence（谁在看/编辑、光标在哪一块）+ 更新广播。
 * 照 server-cache.ts（剧本/cue）同款模式：HMR-safe 全局单例、帧推送、断开清理。
 * 单实例 pm2 部署，内存注册表足够（与剧本 SSE 同前提）。
 */

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

function broadcast(wikiId: string, frame: string): void {
  const clients = sseReg().get(wikiId);
  if (!clients) return;
  for (const push of clients.values()) {
    try { push(frame); } catch { /* broken pipe */ }
  }
}

export function wikiPresenceFrame(wikiId: string): string {
  return `event: presence\ndata: ${JSON.stringify(livePeers(wikiId))}\n\n`;
}

export function registerWikiSSE(
  wikiId: string,
  connectionId: string,
  push: SSEPush,
): () => void {
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
  broadcast(wikiId, wikiPresenceFrame(wikiId));
}

export function removeWikiPresence(wikiId: string, clientId: string): void {
  const m = presReg().get(wikiId);
  if (!m) return;
  m.delete(clientId);
  if (m.size === 0) presReg().delete(wikiId);
  broadcast(wikiId, wikiPresenceFrame(wikiId));
}

/** 内容/标题更新广播（byClientId 供发起端自过滤） */
export function broadcastWikiUpdate(
  wikiId: string,
  payload: { byClientId: string | null; title: string | null; body: string; updatedAt: string },
): void {
  broadcast(wikiId, `event: update\ndata: ${JSON.stringify(payload)}\n\n`);
}
