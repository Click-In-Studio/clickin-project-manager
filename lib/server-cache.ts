/**
 * server-cache.ts — SSE, presence, and cue registry.
 *
 * The in-memory block/char/scene cache has been removed.
 * All script state is read directly from PostgreSQL; writes use
 * applyPatchToDB (lib/db.ts) with a pg_advisory_xact_lock for
 * serialisation. This file only manages:
 *
 *  • SSE connections (script editor real-time seq broadcast)
 *  • Script presence (who's editing which block)
 *  • Cue SSE connections
 *  • Cue presence
 *  • A lightweight per-version seq counter (notification only)
 */

import { registerSSEKeepalive } from "@/lib/sse-keepalive";

// ─── Presence types ───────────────────────────────────────────────────────────

export type PresenceClient = {
  clientId: string;
  userName: string;
  color: string;
  blockId: string | null;
  updatedAt: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const PRESENCE_COLORS = [
  "#E53E3E", "#DD6B20", "#D69E2E", "#38A169",
  "#3182CE", "#805AD5", "#D53F8C", "#00B5D8",
];

function assignColor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = ((h * 31) + clientId.charCodeAt(i)) & 0xffff;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length];
}

// ─── HMR-safe global singletons ───────────────────────────────────────────────

type SSEPush = (frame: string) => void;
type SSEClient = { clientId: string; push: SSEPush };

const g = global as typeof globalThis & {
  __sseRegistry?:      Map<string, Map<string, SSEClient>>;
  __presenceRegistry?: Map<string, Map<string, PresenceClient>>;
  __seqCounters?:      Map<string, number>;
  __cueSSERegistry?:   Map<string, Map<string, SSEPush>>;
  __cuePresenceRegistry?: Map<string, Map<string, CuePresenceClient>>;
};

function sseRegistry(): Map<string, Map<string, SSEClient>> {
  if (!g.__sseRegistry) g.__sseRegistry = new Map();
  return g.__sseRegistry;
}
function presenceRegistry(): Map<string, Map<string, PresenceClient>> {
  if (!g.__presenceRegistry) g.__presenceRegistry = new Map();
  return g.__presenceRegistry;
}
function seqCounters(): Map<string, number> {
  if (!g.__seqCounters) g.__seqCounters = new Map();
  return g.__seqCounters;
}
function cueSSEReg(): Map<string, Map<string, SSEPush>> {
  if (!g.__cueSSERegistry) g.__cueSSERegistry = new Map();
  return g.__cueSSERegistry;
}
function cuePresReg(): Map<string, Map<string, CuePresenceClient>> {
  if (!g.__cuePresenceRegistry) g.__cuePresenceRegistry = new Map();
  return g.__cuePresenceRegistry;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cacheKey(productionId: string, versionId: string): string {
  return `${productionId}:${versionId}`;
}

function broadcast(key: string, frame: string): void {
  const clients = sseRegistry().get(key);
  if (!clients) return;
  for (const client of clients.values()) {
    try { client.push(frame); } catch { /* ignore broken pipe */ }
  }
}

// ─── Seq counter ──────────────────────────────────────────────────────────────

/** Increments the per-version seq counter and returns the new value. */
export function tickSeq(productionId: string, versionId: string): number {
  const key = cacheKey(productionId, versionId);
  const counters = seqCounters();
  const seq = (counters.get(key) ?? 0) + 1;
  counters.set(key, seq);
  return seq;
}

/** Increments seq and immediately broadcasts it to all connected SSE clients. */
export function tickAndBroadcastSeq(productionId: string, versionId: string): number {
  const seq = tickSeq(productionId, versionId);
  const key = cacheKey(productionId, versionId);
  broadcast(key, `data: ${JSON.stringify({ seq })}\n\n`);
  return seq;
}

/** Broadcast a named SSE event (e.g. "config") without incrementing seq. */
export function broadcastEvent(
  productionId: string,
  versionId: string,
  event: string,
  data: unknown,
): void {
  const key = cacheKey(productionId, versionId);
  broadcast(key, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── SSE registration ─────────────────────────────────────────────────────────

/**
 * Register an SSE connection for a production version.
 * Returns a cleanup function that removes the connection and returns whether
 * the client still has any other active connections.
 */
export function registerSSE(
  productionId: string,
  versionId: string,
  connectionId: string,
  clientId: string,
  push: SSEPush,
): () => boolean {
  const key = cacheKey(productionId, versionId);
  const reg = sseRegistry();
  if (!reg.has(key)) reg.set(key, new Map());
  reg.get(key)!.set(connectionId, { clientId, push });
  const releaseKeepalive = registerSSEKeepalive(push);
  return () => {
    releaseKeepalive();
    const clients = reg.get(key);
    clients?.delete(connectionId);
    if (!clients) return false;
    for (const client of clients.values()) {
      if (client.clientId === clientId) return true;
    }
    return false;
  };
}

/**
 * 该 clientId 在此 (production, version) 上是否有活跃 SSE 连接。
 *
 * #460 心跳快路径的依据：SSE 建连时已过与 presence POST 完全相同的权限门
 * （getProductionPermissionContext + hasGrant + 版本归属校验），注册表里查得到
 * 就等于校验过——心跳无需重跑那 7 条 DB 查询。连接断开即失效，无 TTL 缓存。
 */
export function hasActiveSSEClient(productionId: string, versionId: string, clientId: string): boolean {
  const clients = sseRegistry().get(cacheKey(productionId, versionId));
  if (!clients) return false;
  for (const client of clients.values()) {
    if (client.clientId === clientId) return true;
  }
  return false;
}

// ─── Presence ─────────────────────────────────────────────────────────────────

export function getPresence(productionId: string, versionId: string): PresenceClient[] {
  const key = cacheKey(productionId, versionId);
  const clients = presenceRegistry().get(key);
  if (!clients) return [];
  const cutoff = Date.now() - 90_000;
  return Array.from(clients.values()).filter(p => p.updatedAt >= cutoff);
}

export function updatePresence(
  productionId: string,
  versionId: string,
  clientId: string,
  userName: string,
  blockId: string | null,
): void {
  const key = cacheKey(productionId, versionId);
  const reg = presenceRegistry();
  if (!reg.has(key)) reg.set(key, new Map());
  reg.get(key)!.set(clientId, {
    clientId, userName, color: assignColor(clientId), blockId, updatedAt: Date.now(),
  });
  broadcastPresence(key);
}

export function removePresence(productionId: string, versionId: string, clientId: string): void {
  const key = cacheKey(productionId, versionId);
  presenceRegistry().get(key)?.delete(clientId);
  broadcastPresence(key);
}

export function presenceFrameFor(productionId: string, versionId: string): string {
  return presenceFrame(cacheKey(productionId, versionId));
}

function presenceFrame(key: string): string {
  const [productionId, versionId] = key.split(':');
  const list = getPresence(productionId, versionId);
  return `event: presence\ndata: ${JSON.stringify(list)}\n\n`;
}

function broadcastPresence(key: string): void {
  broadcast(key, presenceFrame(key));
}

// ─── Cue SSE ──────────────────────────────────────────────────────────────────

export function registerCueSSE(productionId: string, clientId: string, push: SSEPush): () => void {
  const reg = cueSSEReg();
  if (!reg.has(productionId)) reg.set(productionId, new Map());
  reg.get(productionId)!.set(clientId, push);
  const releaseKeepalive = registerSSEKeepalive(push);
  return () => {
    releaseKeepalive();
    reg.get(productionId)?.delete(clientId);
  };
}

/** cue 版的 hasActiveSSEClient（#460）：cue-stream 建连门与 cue-presence 心跳门逐字相同。 */
export function hasActiveCueSSEClient(productionId: string, clientId: string): boolean {
  return cueSSEReg().get(productionId)?.has(clientId) ?? false;
}

export function broadcastCueUpdate(productionId: string): void {
  const clients = cueSSEReg().get(productionId);
  if (!clients) return;
  const frame = `data: ${JSON.stringify({ updated: true })}\n\n`;
  for (const push of clients.values()) {
    try { push(frame); } catch { /* ignore broken pipe */ }
  }
}

// ─── Cue presence ─────────────────────────────────────────────────────────────

export type CuePresenceClient = {
  clientId: string;
  userName: string;
  color: string;
  listId: string | null;
  cueId: string | null;
  updatedAt: number;
};

function getCuePresence(productionId: string): CuePresenceClient[] {
  const clients = cuePresReg().get(productionId);
  if (!clients) return [];
  const cutoff = Date.now() - 90_000;
  return Array.from(clients.values()).filter(p => p.updatedAt >= cutoff);
}

export function cuePresenceFrame(productionId: string): string {
  return `event: presence\ndata: ${JSON.stringify(getCuePresence(productionId))}\n\n`;
}

function broadcastCuePresence(productionId: string): void {
  const clients = cueSSEReg().get(productionId);
  if (!clients) return;
  const frame = cuePresenceFrame(productionId);
  for (const push of clients.values()) {
    try { push(frame); } catch { /* ignore */ }
  }
}

export function updateCuePresence(
  productionId: string,
  clientId: string,
  userName: string,
  listId: string | null,
  cueId: string | null,
): void {
  const reg = cuePresReg();
  if (!reg.has(productionId)) reg.set(productionId, new Map());
  reg.get(productionId)!.set(clientId, {
    clientId, userName, color: assignColor(clientId), listId, cueId, updatedAt: Date.now(),
  });
  broadcastCuePresence(productionId);
}

export function removeCuePresence(productionId: string, clientId: string): void {
  cuePresReg().get(productionId)?.delete(clientId);
  broadcastCuePresence(productionId);
}
