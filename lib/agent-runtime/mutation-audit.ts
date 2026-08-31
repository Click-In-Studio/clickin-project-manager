// AI 写操作的 diff 审计（db/add-agent-mutation.sql）。
//
// 原则（2026-08-30 定谳）：
// - **每一次 AI 落地的写都有 before/after**。聊天里的确认卡审的是意图（args），不是结果；
//   写完之后发生了什么，靠这里说清楚。它同时是无人值守（定时任务）写的合法性来源——
//   先做后审，审得了才能先做。
// - **审计通用，撤销分域且永远是人做**：本模块只读不改，没有 revert 入口。
// - **按域注册快照读取器，不按工具**：`mutates` 声明已经回答"动了哪个域的哪些 id"，
//   这里只需要每个域一个 `read(ids)`。新写工具只要声明 mutates 就自动进账本；
//   新域加一个读取器。没有读取器的域退化为只记事实（无快照）。
// - **观察到变化才落行**：写工具返回"权限被拒绝"之类的非错误文本时并没有写；
//   created 靠"写前后 id 集合之差"、updated/deleted 靠快照相等与否判定，
//   不信任工具的返回文本。
//
// 快照里的 body 只在内存里参与 diff 统计，**不落库**（wiki 正文历史在 wiki_revision，
// 快照只存 revisionId 引用）；其余字段都是短文本。

import { diffLines } from "diff";
import { getPool } from "@/lib/pg";
import { newMutationId } from "./ids";
import type { ToolMutation } from "./tools";

export type Snapshot = Record<string, unknown> & { label?: string; body?: string };

export type MutationChange =
  | { field: string; from: unknown; to: unknown }
  | { field: "body"; added: number; removed: number };

export interface MutationRecord {
  id: string;
  scope: string;
  action: ToolMutation["action"];
  entityId: string | null;
  label: string | null;
  changes: MutationChange[];
}

interface AuditCtx {
  userId: string;
  productionId: string | null;
  runId: string | null;
  sessionId: string | null;
  tool: string;
  toolCallId: string;
  summary: string | null;
  unattended: boolean;
}

// ── 域读取器 ──────────────────────────────────────────────────────────────────

interface ScopeReader {
  /** 按 id 读快照（不存在的 id 不出现在结果里） */
  read: (ids: string[], ctx: { userId: string; productionId: string | null }) => Promise<Map<string, Snapshot>>;
  /** created 判定用：该域当前全部 id（无具体 id 的写动作靠前后集合之差找出新实体） */
  listIds?: (ctx: { userId: string; productionId: string | null }) => Promise<string[]>;
  /** mutates 没给 ids 时的缺省实体（如个人指令 = 用户本人） */
  defaultIds?: (ctx: { userId: string; productionId: string | null }) => string[];
}

const READERS: Record<string, ScopeReader> = {
  wiki: {
    read: async (ids, { productionId }) => {
      const out = new Map<string, Snapshot>();
      if (!productionId) return out;
      const { getWiki, listWikiDeptShares, listWikiSharePeople } = await import("@/lib/wiki-db");
      // 批量写（≤50 篇）逐篇串行会放大 N 倍往返，按 id 并行（AI review #398）
      const snaps = await Promise.all(ids.map(async (id) => {
        const doc = await getWiki(id, productionId).catch(() => null);
        if (!doc) return null;
        const [rev, depts, people] = await Promise.all([
          latestWikiRevisionId(id),
          listWikiDeptShares(id).catch(() => [] as string[]),
          listWikiSharePeople(id, productionId).catch(() => [] as Array<{ userId: string; level: string }>),
        ]);
        const snap: Snapshot = {
          label: doc.title ?? "",
          title: doc.title ?? "",
          parentId: doc.parentId,
          tags: [...doc.tags].sort(),
          isPublic: doc.isPublic,
          deptShares: [...depts].sort(),
          people: people.map((p) => `${p.userId}:${p.level}`).sort(),
          revisionId: rev,
          bodyChars: doc.body.length,
          body: doc.body,
        };
        return [id, snap] as const;
      }));
      for (const s of snaps) if (s) out.set(s[0], s[1]);
      return out;
    },
    listIds: async ({ productionId }) => {
      if (!productionId) return [];
      const { listWikiLibrary } = await import("@/lib/wiki-db");
      return (await listWikiLibrary(productionId)).map((w) => w.id);
    },
  },
  scene: {
    read: async (ids, { productionId }) => {
      const out = new Map<string, Snapshot>();
      const scenes = await listScenes(productionId);
      const want = new Set(ids);
      for (const s of scenes) {
        if (!want.has(s.id)) continue;
        out.set(s.id, {
          label: s.name,
          name: s.name,
          parentId: s.parentId ?? null,
          synopsis: s.synopsis,
          actionLine: s.actionLine,
          music: s.music,
          stageNotes: s.stageNotes,
          expectedDuration: s.expectedDuration,
        });
      }
      return out;
    },
    listIds: async ({ productionId }) => (await listScenes(productionId)).map((s) => s.id),
  },
  character: {
    read: async (ids, { productionId }) => {
      const out = new Map<string, Snapshot>();
      const chars = await listCharacters(productionId);
      const want = new Set(ids);
      for (const c of chars) {
        if (!want.has(c.id)) continue;
        out.set(c.id, {
          label: c.name,
          name: c.name,
          isAggregate: c.isAggregate,
          memberIds: [...c.memberIds].sort(),
          gender: c.gender,
          roleType: c.roleType,
          biography: c.biography,
        });
      }
      return out;
    },
    listIds: async ({ productionId }) => (await listCharacters(productionId)).map((c) => c.id),
  },
  "instructions.personal": {
    read: async (ids) => {
      const { getAgentInstructions } = await import("@/lib/agent-instructions");
      const out = new Map<string, Snapshot>();
      for (const id of ids) out.set(id, { body: (await getAgentInstructions("user", id)) ?? "" }); // 域名即名字，label 留空
      return out;
    },
    defaultIds: ({ userId }) => [userId],
  },
  "instructions.production": {
    read: async (ids) => {
      const { getAgentInstructions } = await import("@/lib/agent-instructions");
      const out = new Map<string, Snapshot>();
      for (const id of ids) out.set(id, { body: (await getAgentInstructions("production", id)) ?? "" });
      return out;
    },
    defaultIds: ({ productionId }) => (productionId ? [productionId] : []),
  },
};

async function latestWikiRevisionId(wikiId: string): Promise<string | null> {
  const r = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM wiki_revision WHERE wiki_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 1`, [wikiId],
  );
  return r.rows[0]?.id ?? null;
}

async function listScenes(productionId: string | null) {
  if (!productionId) return [];
  const { getActiveVersionId, listScenesByVersion } = await import("@/lib/db");
  const versionId = await getActiveVersionId(productionId);
  return versionId ? listScenesByVersion(versionId) : [];
}

async function listCharacters(productionId: string | null) {
  if (!productionId) return [];
  const { getActiveVersionId, listCharactersByVersion } = await import("@/lib/db");
  const versionId = await getActiveVersionId(productionId);
  return versionId ? listCharactersByVersion(versionId) : [];
}

/** 有快照读取器的域（测试对照 mutates 声明的 scope 防漂移）。 */
export const AUDITED_SCOPES: ReadonlySet<string> = new Set(Object.keys(READERS));

// ── diff ──────────────────────────────────────────────────────────────────────

const SHORT = 80;
const clip = (v: unknown): unknown => (typeof v === "string" && v.length > SHORT ? `${v.slice(0, SHORT)}…` : v);

/** 长文本字段：changes 里只允许增删字数形态，绝不带 from/to 原文（落库前有运行时清洗兜底）。 */
const TEXT_DIFF_FIELDS: ReadonlySet<string> = new Set(["body", "biography", "synopsis"]);

/** 字段级变化：body 只记增删字数（正文本身不进账本），其余记 from/to（长文本截短）。 */
export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): MutationChange[] {
  const changes: MutationChange[] = [];
  if (!before || !after) return changes;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("label");
  keys.delete("bodyChars");
  keys.delete("revisionId");
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (TEXT_DIFF_FIELDS.has(k)) {
      const stats = textDiffStats(String(a ?? ""), String(b ?? ""));
      changes.push({ field: k, ...stats } as MutationChange);
      continue;
    }
    changes.push({ field: k, from: clip(a), to: clip(b) });
  }
  return changes;
}

/**
 * 落库前的运行时清洗（AI review #398：MutationChange 的联合在类型层拦不住
 * `{field:"body", from, to}`——`field: string` 结构上包含 "body"）。唯一产生点
 * diffSnapshots 不会这么写，但"正文不进账本"是不变量，不能只靠产生点自觉：
 * 长文本字段带 from/to 一律折算成增删字数后丢弃原文。
 */
export function sanitizeChanges(changes: MutationChange[]): MutationChange[] {
  return changes.map((c) => {
    if (!TEXT_DIFF_FIELDS.has(c.field) || !("from" in c)) return c;
    return { field: c.field, ...textDiffStats(String(c.from ?? ""), String(c.to ?? "")) } as MutationChange;
  });
}

export function textDiffStats(a: string, b: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(a, b)) {
    if (part.added) added += part.value.length;
    else if (part.removed) removed += part.value.length;
  }
  return { added, removed };
}

/** 落库形态：去掉 body（正文不进账本），保留其余短字段。 */
function persistable(s: Snapshot | null): Record<string, unknown> | null {
  if (!s) return null;
  const rest: Record<string, unknown> = { ...s };
  delete rest.body;
  return rest;
}

// ── 账本 ──────────────────────────────────────────────────────────────────────

export interface PendingAudit {
  /** 写完后调用：取 after 快照、判定是否真的变了、落行。永不抛（审计失败不影响写本身）。 */
  commit: () => Promise<MutationRecord[]>;
}

/**
 * 写工具执行前调用：按 mutates 声明取 before 快照（或 created 的 id 集合），返回 commit 句柄。
 * 任何失败都吞掉并返回"什么都不记"的句柄——审计是账本，不是门。
 */
export async function beginMutationAudit(m: ToolMutation, ctx: AuditCtx): Promise<PendingAudit> {
  const noop: PendingAudit = { commit: async () => [] };
  const reader = READERS[m.scope];
  const scopeCtx = { userId: ctx.userId, productionId: ctx.productionId };
  try {
    if (m.action === "created") {
      if (!reader?.listIds) return factOnly(m, ctx);
      const beforeIds = new Set(await reader.listIds(scopeCtx));
      return {
        commit: () => safe(async () => {
          const afterIds = (await reader.listIds!(scopeCtx)).filter((id) => !beforeIds.has(id));
          if (afterIds.length === 0) return [];
          const snaps = await reader.read(afterIds, scopeCtx);
          const records: MutationRecord[] = [];
          for (const id of afterIds) {
            const after = snaps.get(id) ?? null;
            records.push(await insertRow(ctx, m.scope, "created", id, after?.label ?? null, null, after, []));
          }
          return records;
        }),
      };
    }
    const ids = m.ids && m.ids.length > 0 ? m.ids : reader?.defaultIds?.(scopeCtx) ?? [];
    if (!reader || ids.length === 0) return factOnly(m, ctx);
    const before = await reader.read(ids, scopeCtx);
    return {
      commit: () => safe(async () => {
        const after = await reader.read(ids, scopeCtx);
        const records: MutationRecord[] = [];
        for (const id of ids) {
          const b = before.get(id) ?? null;
          const a = after.get(id) ?? null;
          if (m.action === "deleted") {
            if (!b || a) continue; // 写前就不存在 / 写后还在 → 没删
            records.push(await insertRow(ctx, m.scope, "deleted", id, b.label ?? null, b, null, []));
            continue;
          }
          if (!b && !a) continue;
          const changes = diffSnapshots(b, a);
          if (b && a && changes.length === 0) continue; // 没变（权限被拒 / 空更新）
          records.push(await insertRow(ctx, m.scope, b && !a ? "deleted" : !b && a ? "created" : "updated", id, (a ?? b)?.label ?? null, b, a, changes));
        }
        return records;
      }),
    };
  } catch (err) {
    console.error("[agent-runtime] mutation audit begin failed (write proceeds unaudited):", err);
    return noop;
  }
}

/** 没有读取器的域：只记"发生了这次写"（无快照、无 changes），事实不丢。 */
function factOnly(m: ToolMutation, ctx: AuditCtx): PendingAudit {
  return {
    commit: () => safe(async () => {
      const ids = m.ids && m.ids.length > 0 ? m.ids : [null];
      const records: MutationRecord[] = [];
      for (const id of ids) records.push(await insertRow(ctx, m.scope, m.action, id, null, null, null, []));
      return records;
    }),
  };
}

async function safe(fn: () => Promise<MutationRecord[]>): Promise<MutationRecord[]> {
  try {
    return await fn();
  } catch (err) {
    console.error("[agent-runtime] mutation audit commit failed (write already done):", err);
    return [];
  }
}

async function insertRow(
  ctx: AuditCtx, scope: string, action: ToolMutation["action"], entityId: string | null, label: string | null,
  before: Snapshot | null, after: Snapshot | null, changes: MutationChange[],
): Promise<MutationRecord> {
  const id = newMutationId();
  changes = sanitizeChanges(changes);
  await getPool().query(
    `INSERT INTO agent_mutation (id, run_id, session_id, user_id, production_id, tool, tool_call_id, scope, entity_id, action, label, summary, before, after, changes, unattended)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16)`,
    [id, ctx.runId, ctx.sessionId, ctx.userId, ctx.productionId, ctx.tool, ctx.toolCallId, scope, entityId, action,
     label, ctx.summary, JSON.stringify(persistable(before)), JSON.stringify(persistable(after)), JSON.stringify(changes), ctx.unattended],
  );
  return { id, scope, action, entityId, label, changes };
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────

const SCOPE_LABELS: Record<string, string> = {
  wiki: "文档", scene: "场次", character: "角色",
  "instructions.personal": "个人 AI 指令", "instructions.production": "制作 AI 指令",
};
const FIELD_LABELS: Record<string, string> = {
  body: "正文", title: "标题", parentId: "位置", tags: "标签", isPublic: "全员可见", deptShares: "部门分享", people: "分享给个人",
  name: "名称", synopsis: "梗概", actionLine: "行动线", music: "音乐", stageNotes: "舞台呈现", expectedDuration: "时长",
  isAggregate: "聚合/单人", memberIds: "聚合成员", gender: "性别", roleType: "类型", biography: "小传",
};
const ACTION_LABELS: Record<ToolMutation["action"], string> = { created: "新建", updated: "更新", deleted: "删除" };

/** 一条账本行 → 一句人话（会话 notice / 通知改动清单共用）。 */
export function describeMutation(r: Pick<MutationRecord, "scope" | "action" | "label" | "changes">): string {
  const noun = SCOPE_LABELS[r.scope] ?? r.scope;
  const name = r.label ? `《${r.label}》` : "";
  const head = `${ACTION_LABELS[r.action]}${noun}${name}`;
  if (r.action !== "updated" || r.changes.length === 0) return head;
  const parts = r.changes.map((c) => {
    const f = FIELD_LABELS[c.field] ?? c.field;
    if ("added" in c) return `${f} +${c.added}/−${c.removed} 字`;
    return f;
  });
  return `${head}：${parts.join("、")}`;
}

/** 某个 run 的全部账本行（通知用）。 */
export async function listRunMutations(runId: string): Promise<MutationRecord[]> {
  const r = await getPool().query<{ id: string; scope: string; action: ToolMutation["action"]; entity_id: string | null; label: string | null; changes: MutationChange[] }>(
    `SELECT id, scope, action, entity_id, label, changes FROM agent_mutation WHERE run_id = $1 ORDER BY created_at`, [runId],
  );
  return r.rows.map((row) => ({ id: row.id, scope: row.scope, action: row.action, entityId: row.entity_id, label: row.label, changes: row.changes }));
}
