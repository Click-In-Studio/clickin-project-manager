import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/db";
import { createWiki, getWiki } from "@/lib/wiki-db";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { buildTools, exposedName, type RunHandle } from "@/lib/agent-runtime/tools";
import { AUDITED_SCOPES, describeMutation, diffSnapshots, sanitizeChanges, textDiffStats, listRunMutations, type MutationRecord } from "@/lib/agent-runtime/mutation-audit";

// AI 写操作 diff 审计（db/add-agent-mutation.sql）：写工具真改了东西才落行，
// before/after 由域读取器定形，changes 是给人看的字段级变化。

type Row = { scope: string; action: string; entity_id: string | null; label: string | null; summary: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; changes: unknown[]; unattended: boolean; tool: string };
async function rowsFor(userId: string, toolCallId: string): Promise<Row[]> {
  const r = await getPool().query<Row>(
    `SELECT scope, action, entity_id, label, summary, before, after, changes, unattended, tool FROM agent_mutation WHERE user_id = $1 AND tool_call_id = $2 ORDER BY created_at`,
    [userId, toolCallId],
  );
  return r.rows;
}

describe("纯函数：diff 与人话", () => {
  it("diffSnapshots：正文只记增删字数、短字段记 from/to、label/revisionId/bodyChars 不参与", () => {
    const before = { label: "旧", title: "旧标题", body: "第一行\n第二行\n", tags: ["a"], revisionId: "r1", bodyChars: 8 };
    const after = { label: "新", title: "新标题", body: "第一行\n第二行改\n第三行\n", tags: ["a"], revisionId: "r2", bodyChars: 13 };
    const changes = diffSnapshots(before, after);
    expect(changes).toEqual([
      { field: "title", from: "旧标题", to: "新标题" },
      { field: "body", added: "第二行改\n第三行\n".length, removed: "第二行\n".length },
    ]);
    expect(diffSnapshots(before, { ...before })).toEqual([]);
    expect(textDiffStats("", "abc")).toEqual({ added: 3, removed: 0 });
  });

  it("sanitizeChanges：长文本字段带 from/to（类型层拦不住的形态）落库前折算成增删字数、丢弃原文", () => {
    const dirty = [
      { field: "body", from: "很长的原文……", to: "很长的原文……改" },
      { field: "title", from: "a", to: "b" },
    ] as Parameters<typeof sanitizeChanges>[0];
    const clean = sanitizeChanges(dirty);
    expect(clean[0]).not.toHaveProperty("from");
    expect(clean[0]).toMatchObject({ field: "body", added: expect.any(Number), removed: expect.any(Number) });
    expect(clean[1]).toEqual({ field: "title", from: "a", to: "b" });
  });

  it("describeMutation：动作 + 域 + 名 + 变化清单", () => {
    const r: Pick<MutationRecord, "scope" | "action" | "label" | "changes"> = {
      scope: "wiki", action: "updated", label: "灵感库",
      changes: [{ field: "title", from: "a", to: "b" }, { field: "body", added: 340, removed: 12 }],
    };
    expect(describeMutation(r)).toBe("更新文档《灵感库》：标题、正文 +340/−12 字");
    expect(describeMutation({ scope: "scene", action: "created", label: "第一场", changes: [] })).toBe("新建场次《第一场》");
    expect(describeMutation({ scope: "character", action: "deleted", label: null, changes: [] })).toBe("删除角色");
  });
});

describe("注册表 ↔ 读取器防漂移", () => {
  it("每个写工具 mutates 声明的 scope 都有快照读取器（否则新域只记事实不记 diff）", () => {
    const tools = buildTools({ userId: "00000000-0000-0000-0000-000000000000", productionId: "p" });
    const scopes = new Set<string>();
    for (const t of tools) {
      const m = t.mutates?.({ updates: [], items: [], charIds: [] });
      if (m) scopes.add(m.scope);
    }
    expect(scopes.size).toBeGreaterThan(0);
    for (const s of scopes) expect(AUDITED_SCOPES.has(s), s).toBe(true);
  });
});

describe("账本落行（真 DB、真工具函数、无模型）", () => {
  let userId: string;
  let outsiderId: string;
  let prodId: string;

  beforeAll(async () => {
    ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `audit-${shortId()}`, null, false));
    ({ userId: outsiderId } = await upsertFeishuUser(`test-open-${shortId()}`, `audit-out-${shortId()}`, null, false));
    ({ prodId } = await makeProduction(userId));
  });
  afterAll(async () => {
    await getPool().query(`DELETE FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`, [userId]).catch(() => {});
    await cleanupProduction(prodId).catch(() => {});
  });

  const tool = (ctx: { userId: string; productionId: string | null; run?: RunHandle }, name: string) =>
    buildTools(ctx).find((t) => t.name === exposedName(name))!;

  it("个人指令：空 → 有内容落一行（before/after 不含正文、changes 记字数）；同内容重写不落行；noteMutations 收到账本", async () => {
    const noted: Array<[string, MutationRecord[]]> = [];
    const run = { runId: null as unknown as string, sessionId: null as unknown as string, signal: new AbortController().signal, publish: () => {}, setStatus: async () => {}, isDetached: () => false, noteMutations: (id, r) => noted.push([id, r]) } as RunHandle;
    const t = tool({ userId, productionId: null, run }, "my.update_instructions");
    const callId = `c_${shortId()}`;
    await t.execute(callId, { content: "以后叫我导演" }, run.signal);
    const rows = await rowsFor(userId, callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "instructions.personal", action: "updated", entity_id: userId, label: null, tool: "my.update_instructions", unattended: false });
    expect(rows[0].before).toEqual({}); // body 不落库
    expect(rows[0].changes).toEqual([{ field: "body", added: "以后叫我导演".length, removed: 0 }]);
    expect(noted).toHaveLength(1);
    expect(noted[0][0]).toBe(callId);
    expect(describeMutation(noted[0][1][0])).toBe("更新个人 AI 指令：正文 +6/−0 字");

    const again = `c_${shortId()}`;
    await t.execute(again, { content: "以后叫我导演" }, run.signal);
    expect(await rowsFor(userId, again)).toHaveLength(0);
  });

  it("wiki 更新：标题+正文 → 一行，快照存 revisionId 引用而非正文，summary 来自参数", async () => {
    const doc = await createWiki({ productionId: prodId, title: "灵感库", body: "第一条灵感\n", createdBy: userId });
    const t = tool({ userId, productionId: prodId }, "production.wiki_propose_update");
    const callId = `c_${shortId()}`;
    const out = await t.execute(callId, { wikiId: doc.id, title: "灵感库（整理版）", body: "第一条灵感\n第二条灵感\n", summary: "把昨天的子文档大纲并进主文档" }, new AbortController().signal);
    expect(out.content[0]).toMatchObject({ type: "text" });
    const rows = await rowsFor(userId, callId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ scope: "wiki", action: "updated", entity_id: doc.id, label: "灵感库（整理版）", summary: "把昨天的子文档大纲并进主文档" });
    expect(row.before).not.toHaveProperty("body");
    expect(row.after).not.toHaveProperty("body");
    expect(typeof row.before!.revisionId).toBe("string");
    expect(typeof row.after!.revisionId).toBe("string");
    expect(row.before!.revisionId).not.toBe(row.after!.revisionId);
    expect(row.changes).toEqual([
      { field: "title", from: "灵感库", to: "灵感库（整理版）" },
      { field: "body", added: "第二条灵感\n".length, removed: 0 },
    ]);
    // 写后的 revisionId 确实指向新正文
    const rev = await getPool().query<{ body: string }>(`SELECT body FROM wiki_revision WHERE id = $1::uuid`, [row.after!.revisionId]);
    expect(rev.rows[0].body).toBe("第一条灵感\n第二条灵感\n");
  });

  it("wiki 新建：靠写前后 id 集合之差找到新文档 → created 行带 after 快照；非成员被拒 → 不落行", async () => {
    const t = tool({ userId, productionId: prodId }, "production.wiki_propose_create");
    const callId = `c_${shortId()}`;
    await t.execute(callId, { title: "8月30日灵感", body: "今天想到的", summary: "记录" }, new AbortController().signal);
    const rows = await rowsFor(userId, callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "created", label: "8月30日灵感", before: null });
    expect(rows[0].after).toMatchObject({ title: "8月30日灵感", bodyChars: 5 });
    expect(await getWiki(rows[0].entity_id!, prodId)).not.toBeNull();

    const denied = tool({ userId: outsiderId, productionId: prodId }, "production.wiki_propose_create");
    const deniedCall = `c_${shortId()}`;
    const out = await denied.execute(deniedCall, { title: "偷建", summary: "x" }, new AbortController().signal);
    expect(String((out.content[0] as { text: string }).text)).toContain("权限被拒绝");
    expect(await rowsFor(outsiderId, deniedCall)).toHaveLength(0);
  });

  it("wiki 删除：写前在、写后不在 → deleted 行带 before 快照；listRunMutations 按 run 取", async () => {
    const doc = await createWiki({ productionId: prodId, title: "过时的", body: "x", createdBy: userId });
    // 造一个 run 行，让账本挂上 run_id
    const { createNewSessionKey } = await import("@/lib/agent-tools/session-identity");
    const { PgSessionStorage } = await import("@/lib/agent-runtime/pg-session-storage");
    const key = createNewSessionKey(userId, prodId);
    await PgSessionStorage.create({ id: key, userId, productionId: prodId });
    const runId = `ar_audit_${shortId()}`;
    await getPool().query(`INSERT INTO agent_run (id, session_id, status) VALUES ($1, $2, 'running')`, [runId, key]);
    const run = { runId, sessionId: key, signal: new AbortController().signal, publish: () => {}, setStatus: async () => {}, isDetached: () => false, unattended: true } as RunHandle;
    const t = tool({ userId, productionId: prodId, run }, "production.wiki_propose_delete");
    const callId = `c_${shortId()}`;
    await t.execute(callId, { wikiId: doc.id, summary: "清理" }, run.signal);
    const rows = await rowsFor(userId, callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "deleted", label: "过时的", after: null, unattended: true });
    expect(rows[0].before).toMatchObject({ title: "过时的" });
    const byRun = await listRunMutations(runId);
    expect(byRun.map((r) => r.action)).toEqual(["deleted"]);
    // 删会话不删账本（SET NULL）
    await getPool().query(`DELETE FROM agent_session WHERE id = $1`, [key]);
    const still = await getPool().query<{ run_id: string | null }>(`SELECT run_id FROM agent_mutation WHERE id = $1`, [byRun[0].id]);
    expect(still.rows[0]).toEqual({ run_id: null });
  });
});
