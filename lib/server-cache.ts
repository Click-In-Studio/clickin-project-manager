import type { Block, Character, Scene, ScriptState } from "./script-types";
import type { BlockOp, CharOp, SceneOp, ScriptPatch } from "./script-ops";
import { flushToDB } from "./db";
import type { DbBlock } from "./db";
import {
  blockToFields,
  batchCreateRecords,
  batchUpdateRecords,
  batchDeleteRecords,
} from "./feishu-bitable";
import { initialKeys, keyBetween, isValidKey } from "./lex-order";

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_KEY_GAP = 65536;
const RETRY_DELAY_MS = 5_000; // retry delay after a failed flush

// ─── Internal types ───────────────────────────────────────────────────────────

type ServerBlock = Block & {
  orderKey: number; // internal sort (integer, used for fast reorder)
  lexKey: string;   // Feishu-persisted sort key (base-36, 10 chars)
};

type Dirty = {
  blocks: Map<string, ServerBlock>;
  deletedBlockIds: Set<string>;
  chars: Map<string, Character>;
  deletedCharIds: Set<string>;
  scenes: Map<string, Scene>;
  deletedSceneIds: Set<string>;
};

type FeishuSync = {
  appToken: string;
  tableId: string;
  userToken: string;
  hasSortField: boolean;
  // IDs whose block.id IS the Feishu record_id (loaded from Feishu)
  feishuIds: Set<string>;
  // client-generated block ID → Feishu record_id (after first create flush)
  localToFeishu: Map<string, string>;
  // Feishu record_id → last-flushed ServerBlock (for diffing)
  lastSyncedBlocks: Map<string, ServerBlock>;
};

type CacheEntry = {
  scriptId: string;
  blocks: ServerBlock[];       // sorted by orderKey
  characters: Character[];
  scenes: Scene[];
  serverSeq: number;
  dirty: Dirty;
  flushTimer: ReturnType<typeof setTimeout> | null;
  feishu: FeishuSync | null;
};

// ─── Presence types ───────────────────────────────────────────────────────────

export type PresenceClient = {
  clientId: string;
  userName: string;
  color: string;
  blockId: string | null;
  updatedAt: number;
};

const PRESENCE_COLORS = [
  "#E53E3E", "#DD6B20", "#D69E2E", "#38A169",
  "#3182CE", "#805AD5", "#D53F8C", "#00B5D8",
];

function assignColor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = ((h * 31) + clientId.charCodeAt(i)) & 0xffff;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length];
}

// ─── HMR-safe global singleton ────────────────────────────────────────────────

type SSEPush = (frame: string) => void;

const g = global as typeof globalThis & {
  __scriptCache?: Map<string, CacheEntry>;
  __sseRegistry?: Map<string, Map<string, SSEPush>>;
  __presenceRegistry?: Map<string, Map<string, PresenceClient>>;
};

function cache(): Map<string, CacheEntry> {
  if (!g.__scriptCache) g.__scriptCache = new Map();
  return g.__scriptCache;
}

function sseRegistry(): Map<string, Map<string, SSEPush>> {
  if (!g.__sseRegistry) g.__sseRegistry = new Map();
  return g.__sseRegistry;
}

function presenceRegistry(): Map<string, Map<string, PresenceClient>> {
  if (!g.__presenceRegistry) g.__presenceRegistry = new Map();
  return g.__presenceRegistry;
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

export function registerSSE(
  scriptId: string,
  clientId: string,
  push: SSEPush
): () => void {
  const reg = sseRegistry();
  if (!reg.has(scriptId)) reg.set(scriptId, new Map());
  reg.get(scriptId)!.set(clientId, push);
  return () => reg.get(scriptId)?.delete(clientId);
}

function broadcast(scriptId: string, frame: string): void {
  const clients = sseRegistry().get(scriptId);
  if (!clients) return;
  for (const push of clients.values()) {
    try { push(frame); } catch { /* ignore broken pipe */ }
  }
}

function broadcastSeq(scriptId: string, seq: number): void {
  broadcast(scriptId, `data: ${JSON.stringify({ seq })}\n\n`);
}

function presenceFrame(scriptId: string): string {
  const list = getPresence(scriptId);
  return `event: presence\ndata: ${JSON.stringify(list)}\n\n`;
}

function broadcastPresence(scriptId: string): void {
  broadcast(scriptId, presenceFrame(scriptId));
}

// ─── Presence helpers ─────────────────────────────────────────────────────────

export function getPresence(scriptId: string): PresenceClient[] {
  const reg = presenceRegistry();
  const clients = reg.get(scriptId);
  if (!clients) return [];
  // Filter out entries that haven't been updated in 90 s (stale tabs that didn't disconnect cleanly)
  const cutoff = Date.now() - 90_000;
  return Array.from(clients.values()).filter(p => p.updatedAt >= cutoff);
}

export function updatePresence(
  scriptId: string,
  clientId: string,
  userName: string,
  blockId: string | null
): void {
  const reg = presenceRegistry();
  if (!reg.has(scriptId)) reg.set(scriptId, new Map());
  reg.get(scriptId)!.set(clientId, {
    clientId,
    userName,
    color: assignColor(clientId),
    blockId,
    updatedAt: Date.now(),
  });
  broadcastPresence(scriptId);
}

export function removePresence(scriptId: string, clientId: string): void {
  presenceRegistry().get(scriptId)?.delete(clientId);
  broadcastPresence(scriptId);
}

export { presenceFrame };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDirty(): Dirty {
  return {
    blocks: new Map(),
    deletedBlockIds: new Set(),
    chars: new Map(),
    deletedCharIds: new Set(),
    scenes: new Map(),
    deletedSceneIds: new Set(),
  };
}

function midOrderKey(lo: number, hi: number): number {
  return Math.floor((lo + hi) / 2);
}

function blockChanged(a: ServerBlock, b: ServerBlock): boolean {
  return (
    a.content !== b.content ||
    a.type !== b.type ||
    a.lyric !== b.lyric ||
    a.sceneId !== b.sceneId ||
    a.rehearsalMark !== b.rehearsalMark ||
    a.lexKey !== b.lexKey ||
    a.characterIds.length !== b.characterIds.length ||
    a.characterIds.some((id, i) => id !== b.characterIds[i])
  );
}

/**
 * Given blocks (in their intended display order) and a map of record_id → lex key
 * from Feishu, return a lex key string for each block in order.
 * Blocks missing a valid key get one interpolated from their neighbors.
 */
function assignLexKeys(blocks: Block[], sortKeys: Map<string, string>): string[] {
  if (!blocks.length) return [];

  const raw: (string | null)[] = blocks.map(b => {
    const k = sortKeys.get(b.id);
    return k && isValidKey(k) ? k : null;
  });

  if (raw.every(k => k === null)) return initialKeys(blocks.length);

  const result = [...raw];
  for (let i = 0; i < result.length; i++) {
    if (result[i] !== null) continue;
    let lo: string | null = null;
    for (let j = i - 1; j >= 0; j--) { if (result[j] !== null) { lo = result[j]; break; } }
    let hi: string | null = null;
    for (let j = i + 1; j < result.length; j++) { if (result[j] !== null) { hi = result[j]; break; } }
    result[i] = keyBetween(lo, hi);
  }

  return result as string[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getOrCreate(scriptId: string): CacheEntry {
  const c = cache();
  if (!c.has(scriptId)) {
    c.set(scriptId, {
      scriptId,
      blocks: [],
      characters: [],
      scenes: [],
      serverSeq: 0,
      dirty: makeDirty(),
      flushTimer: null,
      feishu: null,
    });
  }
  return c.get(scriptId)!;
}

/**
 * Populate the cache from a freshly loaded Feishu state.
 * Cancels any pending flush and resets dirty tracking.
 * Blocks in `state` must already be in the correct display order
 * (i.e. toScriptState was called with the sort field name).
 */
export function loadFromFeishu(
  scriptId: string,
  state: ScriptState,
  opts: {
    appToken: string;
    tableId: string;
    userToken: string;
    hasSortField: boolean;
    sortKeys: Map<string, string>; // record_id → lex key from Feishu
  }
): void {
  const c = cache();
  const existing = c.get(scriptId);
  if (existing?.flushTimer) clearTimeout(existing.flushTimer);

  const lexKeyArr = assignLexKeys(state.blocks, opts.sortKeys);
  const blocks: ServerBlock[] = state.blocks.map((b, i) => ({
    ...b,
    orderKey: (i + 1) * INITIAL_KEY_GAP,
    lexKey: lexKeyArr[i],
  }));

  const feishuIds = new Set(state.blocks.map(b => b.id));

  // For lastSyncedBlocks, record what Feishu actually has for the sort key
  // (not the generated value). Blocks with a missing/invalid sort key get
  // lexKey "" so the diff sees them as dirty and writes the key back immediately.
  const lastSyncedBlocks = new Map(blocks.map(b => {
    const existing = opts.sortKeys.get(b.id);
    return [b.id, { ...b, lexKey: isValidKey(existing) ? existing : "" }];
  }));

  const entry: CacheEntry = {
    scriptId,
    blocks,
    characters: [...state.characters],
    scenes: [...state.scenes],
    serverSeq: 0,
    dirty: makeDirty(),
    flushTimer: null,
    feishu: {
      appToken: opts.appToken,
      tableId: opts.tableId,
      userToken: opts.userToken,
      hasSortField: opts.hasSortField,
      feishuIds,
      localToFeishu: new Map(),
      lastSyncedBlocks,
    },
  };
  c.set(scriptId, entry);

  // If any sort keys were generated (blocks had no valid key in Feishu),
  // write them back immediately rather than waiting for the next edit flush.
  const hasMissingKeys =
    opts.hasSortField && state.blocks.some(b => !isValidKey(opts.sortKeys.get(b.id)));
  if (hasMissingKeys) {
    flushToFeishu(entry).catch(err =>
      console.error("[feishu] initial sort key write-back error:", err)
    );
  }
}

/**
 * Populate the cache from data loaded out of PostgreSQL.
 * sortKeys maps block_id → the sort_key stored in the DB.
 */
export function loadFromDB(
  productionId: string,
  state: ScriptState,
  sortKeys: Map<string, string>
): void {
  const c = cache();
  const existing = c.get(productionId);
  if (existing?.flushTimer) clearTimeout(existing.flushTimer);

  const lexKeyArr = assignLexKeys(state.blocks, sortKeys);
  const blocks: ServerBlock[] = state.blocks.map((b, i) => ({
    ...b,
    orderKey: (i + 1) * INITIAL_KEY_GAP,
    lexKey: lexKeyArr[i],
  }));

  c.set(productionId, {
    scriptId: productionId,
    blocks,
    characters: [...state.characters],
    scenes: [...state.scenes],
    serverSeq: 0,
    dirty: makeDirty(),
    flushTimer: null,
    feishu: null,
  });
}

/** Returns the current state as seen by the client (strips orderKey and lexKey). */
export function getState(scriptId: string): ScriptState {
  const entry = getOrCreate(scriptId);
  return {
    blocks: entry.blocks.map(({ orderKey: _ok, lexKey: _lk, ...b }) => b),
    characters: [...entry.characters],
    scenes: [...entry.scenes],
  };
}

/**
 * Applies a client patch, flushes to DB immediately, and returns the new serverSeq.
 * If the flush fails it is retried after RETRY_DELAY_MS.
 */
export async function applyPatch(scriptId: string, patch: ScriptPatch, userToken?: string): Promise<number> {
  const entry = getOrCreate(scriptId);

  if (userToken && entry.feishu) {
    entry.feishu.userToken = userToken;
  }

  applyCharOps(entry, patch.charOps);
  applySceneOps(entry, patch.sceneOps);
  applyBlockOps(entry, patch.blockOps);
  sanitizeBlockRefs(entry);

  entry.serverSeq += 1;
  const seq = entry.serverSeq;

  flush(entry)
    .then(() => broadcastSeq(scriptId, seq))
    .catch(err => {
      console.error("[db] flush error, scheduling retry:", err);
      scheduleRetry(entry);
    });

  return seq;
}

// ─── Op application ───────────────────────────────────────────────────────────

/**
 * After metadata ops are applied, walk all blocks and null-out any sceneId or
 * characterIds that reference entities no longer present in this production.
 * This resolves cross-client conflicts where one client deletes a scene/character
 * while another is editing blocks that reference it — metadata always wins.
 */
function sanitizeBlockRefs(entry: CacheEntry): void {
  const validScenes = new Set(entry.scenes.map(s => s.id));
  const validChars  = new Set(entry.characters.map(c => c.id));

  for (let i = 0; i < entry.blocks.length; i++) {
    const b = entry.blocks[i];
    const sceneId = b.sceneId != null && validScenes.has(b.sceneId) ? b.sceneId : null;
    const characterIds = b.characterIds.filter(id => validChars.has(id));

    if (sceneId === b.sceneId && characterIds.length === b.characterIds.length) continue;

    const updated: ServerBlock = { ...b, sceneId, characterIds };
    entry.blocks[i] = updated;
    entry.dirty.blocks.set(updated.id, updated);
    entry.dirty.deletedBlockIds.delete(updated.id);
  }
}

function applyCharOps(entry: CacheEntry, ops: CharOp[]) {
  for (const op of ops) {
    if (op.op === "upsert") {
      const idx = entry.characters.findIndex((c) => c.id === op.char.id);
      if (idx >= 0) entry.characters[idx] = op.char;
      else entry.characters.push(op.char);
      entry.dirty.chars.set(op.char.id, op.char);
      entry.dirty.deletedCharIds.delete(op.char.id);
    } else {
      entry.characters = entry.characters.filter((c) => c.id !== op.id);
      entry.dirty.deletedCharIds.add(op.id);
      entry.dirty.chars.delete(op.id);
    }
  }
}

function applySceneOps(entry: CacheEntry, ops: SceneOp[]) {
  for (const op of ops) {
    if (op.op === "upsert") {
      const idx = entry.scenes.findIndex((s) => s.id === op.scene.id);
      if (idx >= 0) entry.scenes[idx] = op.scene;
      else entry.scenes.push(op.scene);
      entry.dirty.scenes.set(op.scene.id, op.scene);
      entry.dirty.deletedSceneIds.delete(op.scene.id);
    } else {
      entry.scenes = entry.scenes.filter((s) => s.id !== op.id);
      entry.dirty.deletedSceneIds.add(op.id);
      entry.dirty.scenes.delete(op.id);
    }
  }
}

function applyBlockOps(entry: CacheEntry, ops: BlockOp[]) {
  for (const op of ops) {
    switch (op.op) {
      case "insert": {
        const afterIdx = op.afterId
          ? entry.blocks.findIndex((b) => b.id === op.afterId)
          : -1;

        const prevBlock = afterIdx >= 0 ? entry.blocks[afterIdx] : null;
        const nextBlock =
          afterIdx + 1 < entry.blocks.length ? entry.blocks[afterIdx + 1] : null;

        const prevOrderKey = prevBlock?.orderKey ?? 0;
        const nextOrderKey = nextBlock?.orderKey ?? prevOrderKey + INITIAL_KEY_GAP * 2;
        const orderKey =
          nextOrderKey - prevOrderKey > 1
            ? midOrderKey(prevOrderKey, nextOrderKey)
            : prevOrderKey + INITIAL_KEY_GAP;

        const lexKey = keyBetween(prevBlock?.lexKey ?? null, nextBlock?.lexKey ?? null);

        const sb: ServerBlock = { ...op.block, orderKey, lexKey };
        entry.blocks.splice(afterIdx + 1, 0, sb);
        entry.dirty.blocks.set(sb.id, sb);
        entry.dirty.deletedBlockIds.delete(sb.id);
        break;
      }

      case "update": {
        const idx = entry.blocks.findIndex((b) => b.id === op.block.id);
        if (idx >= 0) {
          const sb: ServerBlock = {
            ...op.block,
            orderKey: entry.blocks[idx].orderKey,
            lexKey: entry.blocks[idx].lexKey,
          };
          entry.blocks[idx] = sb;
          entry.dirty.blocks.set(sb.id, sb);
        }
        break;
      }

      case "delete": {
        entry.blocks = entry.blocks.filter((b) => b.id !== op.id);
        entry.dirty.deletedBlockIds.add(op.id);
        entry.dirty.blocks.delete(op.id);
        break;
      }

      case "reorder": {
        const reordered: ServerBlock[] = op.ids
          .map((id) => entry.blocks.find((b) => b.id === id))
          .filter((b): b is ServerBlock => !!b);

        for (let i = 0; i < reordered.length; i++) {
          const prevOrderKey = i > 0 ? reordered[i - 1].orderKey : 0;
          const prevLexKey = i > 0 ? reordered[i - 1].lexKey : null;
          const nextLexKey =
            i + 1 < reordered.length ? reordered[i + 1].lexKey : null;

          let needsUpdate = false;

          // Check if orderKey is still valid
          let newOrderKey = reordered[i].orderKey;
          if (newOrderKey <= prevOrderKey) {
            const nextStable =
              i + 1 < reordered.length
                ? reordered[i + 1].orderKey
                : prevOrderKey + INITIAL_KEY_GAP * 2;
            newOrderKey =
              nextStable > prevOrderKey + 1
                ? midOrderKey(prevOrderKey, nextStable)
                : prevOrderKey + INITIAL_KEY_GAP;
            needsUpdate = true;
          }

          // Check if lexKey is still valid (strictly between neighbors)
          let newLexKey = reordered[i].lexKey;
          const lexOk =
            (!prevLexKey || newLexKey > prevLexKey) &&
            (!nextLexKey || newLexKey < nextLexKey);
          if (!lexOk) {
            newLexKey = keyBetween(prevLexKey, nextLexKey);
            needsUpdate = true;
          }

          if (needsUpdate) {
            reordered[i] = { ...reordered[i], orderKey: newOrderKey, lexKey: newLexKey };
            entry.dirty.blocks.set(reordered[i].id, reordered[i]);
          }
        }

        entry.blocks = reordered;
        break;
      }
    }
  }
}

// ─── Flush ────────────────────────────────────────────────────────────────────

async function flushToFeishu(entry: CacheEntry): Promise<void> {
  const sync = entry.feishu;
  if (!sync) return;

  const { appToken, tableId, userToken, hasSortField, feishuIds, localToFeishu, lastSyncedBlocks } = sync;
  const { scenes, characters } = entry;

  const getFeishuId = (blockId: string): string | null => {
    if (localToFeishu.has(blockId)) return localToFeishu.get(blockId)!;
    if (feishuIds.has(blockId)) return blockId;
    return null;
  };

  const toCreate: { localId: string; fields: Record<string, unknown> }[] = [];
  const toUpdate: { record_id: string; fields: Record<string, unknown> }[] = [];
  const currentFeishuIds = new Set<string>();

  for (const block of entry.blocks) {
    const fid = getFeishuId(block.id);
    const baseFields = blockToFields(block, scenes, characters);
    const fields = hasSortField ? { ...baseFields, 排序: block.lexKey } : baseFields;

    if (fid === null) {
      toCreate.push({ localId: block.id, fields });
    } else {
      currentFeishuIds.add(fid);
      const last = lastSyncedBlocks.get(fid);
      if (!last || blockChanged(block, last)) {
        toUpdate.push({ record_id: fid, fields });
      }
    }
  }

  const toDelete: string[] = [];
  for (const fid of lastSyncedBlocks.keys()) {
    if (!currentFeishuIds.has(fid)) toDelete.push(fid);
  }

  if (!toCreate.length && !toUpdate.length && !toDelete.length) return;

  const [newIds] = await Promise.all([
    toCreate.length > 0
      ? batchCreateRecords(appToken, tableId, userToken, toCreate.map(c => c.fields))
      : Promise.resolve([] as string[]),
    toUpdate.length > 0
      ? batchUpdateRecords(appToken, tableId, userToken, toUpdate)
      : Promise.resolve(),
    toDelete.length > 0
      ? batchDeleteRecords(appToken, tableId, userToken, toDelete)
      : Promise.resolve(),
  ]);

  // Update sync state to reflect what's now in Feishu
  for (let i = 0; i < toCreate.length; i++) {
    const { localId } = toCreate[i];
    const feishuId = newIds[i];
    localToFeishu.set(localId, feishuId);
    feishuIds.add(feishuId);
    const block = entry.blocks.find(b => b.id === localId);
    if (block) lastSyncedBlocks.set(feishuId, { ...block });
  }

  for (const { record_id } of toUpdate) {
    const block = entry.blocks.find(b => getFeishuId(b.id) === record_id);
    if (block) lastSyncedBlocks.set(record_id, { ...block });
  }

  for (const fid of toDelete) {
    lastSyncedBlocks.delete(fid);
    feishuIds.delete(fid);
  }
}

async function flush(entry: CacheEntry) {
  if (entry.flushTimer !== null) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }

  const d = entry.dirty;
  entry.dirty = makeDirty();

  const sceneOrder = new Map(entry.scenes.map((s, i) => [s.id, i]));
  const charOrder = new Map(entry.characters.map((c, i) => [c.id, i]));

  await flushToDB(entry.scriptId, {
    upsertBlocks: Array.from(d.blocks.values()) as DbBlock[],
    deleteBlockIds: Array.from(d.deletedBlockIds),
    upsertChars: Array.from(d.chars.values()).map(c => ({ ...c, sortOrder: charOrder.get(c.id) ?? 0 })),
    deleteCharIds: Array.from(d.deletedCharIds),
    upsertScenes: Array.from(d.scenes.values()).map(s => ({ ...s, sortOrder: sceneOrder.get(s.id) ?? 0 })),
    deleteSceneIds: Array.from(d.deletedSceneIds),
  });

  await flushToFeishu(entry).catch(err => {
    console.error("[feishu] flush error:", err);
  });
}

function scheduleRetry(entry: CacheEntry) {
  if (entry.flushTimer !== null) return;
  entry.flushTimer = setTimeout(() => flush(entry).catch(err => {
    console.error("[db] retry flush error:", err);
    entry.flushTimer = null;
    scheduleRetry(entry);
  }), RETRY_DELAY_MS);
}
