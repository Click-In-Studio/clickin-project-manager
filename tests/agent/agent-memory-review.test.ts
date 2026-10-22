import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { getPool } from "@/lib/pg";
import { memoryTransaction, memoryId } from "@/lib/agent/memory/memory-access-db";
import { mutateMemoryEntry, readMemoryScope } from "@/lib/agent/memory/memory-db";
import { evictMemoryCache, readGroupPage, readMemoryGroups, refreshGroup } from "@/lib/agent/memory/memory-group-db";
import { readOrganizeCandidates, markOrganized } from "@/lib/agent/memory/memory-organize-db";
import { readSummaryProgress, saveSummaryProgress } from "@/lib/agent/memory/memory-summary-db";
import { summarizeMemoryGroup } from "@/lib/agent/memory/organize";
import { indexEpisodicRun } from "@/lib/agent/memory/index-db";
import { searchMemory } from "@/lib/agent/memory/search";
import { buildInjectContext } from "@/lib/agent/memory/inject";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import { enqueueMemoryMaintenance } from "@/lib/agent/memory/memory-jobs";
import { getJobHandlerDef } from "@/lib/job/handlers";
import { checkMemoryOrigin } from "@/lib/agent/memory/memory-access-db";
import { PgSessionStorage } from "@/lib/agent/runtime/pg-session-storage";
import { embeddingModel } from "@/lib/agent/memory/embedding";

const llm = vi.fn();
vi.mock("@/lib/agent/llm-chat", () => ({ chat: (...args: unknown[]) => llm(...args) }));
let uid: string, pid: string;
beforeAll(async () => {
  uid = (await upsertFeishuUser(`memory-review-${shortId()}`, "记忆边界", null, false)).userId;
  ({ prodId: pid } = await makeProduction(uid));
});
beforeEach(async () => {
  process.env.EMBEDDING_PROVIDER = "none";
  process.env.JOB_WORKER = "1";
  await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [uid]);
  await getPool().query("DELETE FROM agent_memory_chunk WHERE scope_id=$1", [uid]);
  await getPool().query("DELETE FROM job WHERE payload->>'userId'=$1", [uid]);
  llm.mockReset().mockResolvedValue({ value: "各方说法尚待核对" });
});
afterAll(async () => {
  await getPool().query("DELETE FROM agent_session WHERE user_id=$1", [uid]);
  await getPool().query("DELETE FROM job WHERE payload->>'userId'=$1", [uid]);
  await getPool().query("DELETE FROM agent_memory_chunk WHERE scope_id=$1", [uid]);
  await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [uid]);
  await cleanupProduction(pid).catch(() => {});
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.JOB_WORKER;
});
const create = (body: string, project: string | null = pid) =>
  mutateMemoryEntry(uid, project, { action: "create", actor: "agent", body, brief: body });

/** 批量构造真实连通组，避免用两百次图合并替代摘要边界测试。 */
async function makeGroup(n: number, star = false) {
  return memoryTransaction(uid, pid, async (c, s) => {
    const groupId = memoryId();
    const ids = Array.from({ length: n }, () => memoryId());
    await c.query("INSERT INTO agent_memory_group(id,scope_id) VALUES($1,$2)", [groupId, s.id]);
    await c.query(
      `INSERT INTO agent_memory_entry(id,scope_id,group_id,body,brief,source,created_at)
       SELECT id,$1,$2,'条目'||i,'条件'||i,'active',clock_timestamp()+i*interval '1 millisecond'
       FROM unnest($3::text[]) WITH ORDINALITY t(id,i)`, [s.id, groupId, ids],
    );
    const left = ids.slice(1).map((_, i) => star ? ids[0] : ids[i]);
    await c.query(
      `INSERT INTO agent_memory_relation(id,scope_id,left_entry_id,right_entry_id,kind,reason,left_revision,right_revision)
       SELECT 'rel_'||r,$1,least(l,r),greatest(l,r),'conflict','各方需要核对',0,0
       FROM unnest($2::text[],$3::text[]) t(l,r)`, [s.id, left, ids.slice(1)],
    );
    await refreshGroup(c, s.id, groupId);
    return { groupId, ids, revision: 1 };
  });
}

describe("缓存与检索输入", () => {
  it("最新组超过A时仍保留后面放得下的小组，长期内容均保留", async () => {
    const small = await create("小组仍应常驻");
    const large = await makeGroup(30);
    await create("小组二");
    await create("小组三");
    await create("小组四");
    await create("小组五");
    await create("小组六");
    await getPool().query("UPDATE agent_memory_group SET last_touched_at=now()+interval '1 hour' WHERE id=$1", [large.groupId]);
    const evicted = await evictMemoryCache(uid, pid);
    expect(evicted).toContain(large.groupId);
    expect((await readMemoryGroups(uid, pid)).reduce((n, g) => n + g.memberCount, 0)).toBe(6);
    expect((await readMemoryGroups(uid, pid)).flatMap(g => g.entries).some(e => e.id === small)).toBe(true);
    expect((await readMemoryScope(uid, pid)).entries).toHaveLength(36);
  });

  it("只用用户正文召回冷记忆，界面和附件清单不参与排名", async () => {
    const id = await create("排练时间周五下午三点");
    await getPool().query("UPDATE agent_memory_group SET in_cache=false WHERE id=(SELECT group_id FROM agent_memory_entry WHERE id=$1)", [id]);
    const prompt = `<clickin-ui-context>灯光舞台服装化妆视频舞美道具文档素材页面</clickin-ui-context>\n<clickin-attachment-context>一大段无关的文件清单、预检和使用提示</clickin-attachment-context>\n排练时间`;
    const context = await buildInjectContext(uid, createNewSessionKey(uid, pid), prompt);
    expect(context.memory).toContain("排练时间周五下午三点");
  });
});

describe("历史失效范围", () => {
  it("通用记忆更正不阻断旧项目会话维护项目记忆，但仍阻断旧会话重写通用记忆", async () => {
    const sessionId = createNewSessionKey(uid, pid);
    await PgSessionStorage.create({ id: sessionId, userId: uid, productionId: pid });
    const runId = `review_run_${shortId()}`;
    await getPool().query("INSERT INTO agent_run(id,session_id,status,started_at) VALUES($1,$2,'running',now()-interval '1 minute')", [runId, sessionId]);
    const id = await mutateMemoryEntry(uid, null, { action: "create", actor: "user", body: "通用旧要求" });
    await mutateMemoryEntry(uid, null, { action: "delete", actor: "user", id, revision: 0 });
    await expect(memoryTransaction(uid, pid, (c) => checkMemoryOrigin(c, uid, pid, runId))).resolves.toBeUndefined();
    await expect(memoryTransaction(uid, null, (c) => checkMemoryOrigin(c, uid, null, runId))).rejects.toThrow(/旧会话/);
  });

  it("编辑通用条目只清理通用历史，项目历史仍可搜索和补建", async () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    const id = await mutateMemoryEntry(uid, null, { action: "create", actor: "user", body: "个人偏好" });
    await indexEpisodicRun(uid, { ts, lastUser: "通用旧材料" }, { deferEmbedding: true });
    await indexEpisodicRun(uid, { ts, productionId: pid, lastUser: "项目排练安排" }, { deferEmbedding: true });
    await mutateMemoryEntry(uid, null, { action: "update", id, revision: 0, actor: "user", body: "个人偏好修正" });
    const rows = (await getPool().query("SELECT production_id FROM agent_memory_chunk WHERE scope_id=$1", [uid])).rows;
    expect(rows).toEqual([{ production_id: pid }]);
    expect((await searchMemory(uid, "项目排练安排", pid)).hits).not.toHaveLength(0);
    expect((await searchMemory(uid, "项目排练安排")).hits).not.toHaveLength(0);
    await indexEpisodicRun(uid, { ts, productionId: pid, lastUser: "项目旧材料补建" }, { deferEmbedding: true });
    await indexEpisodicRun(uid, { ts, lastUser: "通用旧材料不可重建" }, { deferEmbedding: true });
    const rebuilt = (await getPool().query("SELECT production_id,text FROM agent_memory_chunk WHERE scope_id=$1", [uid])).rows;
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt.every(r => r.production_id === pid)).toBe(true);
  });
});

describe("整理候选", () => {
  it("可以复用当前向量找出无词面重叠的条目，旧修订向量不参与匹配", async () => {
    const old = await create("harp arrangement");
    await getPool().query("UPDATE agent_memory_entry SET organized_revision=revision,organization_checked_at=now() WHERE id=$1", [old]);
    const seed = await create("弦乐编配");
    const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
    await getPool().query("UPDATE agent_memory_entry SET embedding=$2::vector,embedding_revision=revision,embedding_model=$3 WHERE id=ANY($1::text[])", [[old, seed], JSON.stringify(vector), embeddingModel()]);
    expect((await readOrganizeCandidates(uid, pid)).entries.map(e => e.id)).toContain(old);
    await getPool().query("UPDATE agent_memory_entry SET embedding_revision=-1 WHERE id=$1", [old]);
    expect((await readOrganizeCandidates(uid, pid)).entries.map(e => e.id)).toEqual([seed]);
  });

  it("中文改写能找到旧条目，不因多个新条目共用八个名额遗漏", async () => {
    const old = await create("诗经舞美采用蒹葭意象");
    for (let i = 0; i < 12; i++) await create(`机械控制协议编号${i}`);
    await getPool().query("UPDATE agent_memory_entry SET organized_revision=revision,organization_checked_at=now() WHERE scope_id=(SELECT id FROM agent_memory_scope WHERE user_id=$1 AND production_id=$2)", [uid, pid]);
    await create("导演确认这一幕的舞美从蒹葭寻找意象");
    const candidates = await readOrganizeCandidates(uid, pid);
    expect(candidates.entries.some(e => e.id === old)).toBe(true);
    expect(candidates.checked).toHaveLength(1);
    await markOrganized(uid, pid, candidates.entries.filter(e => candidates.checked.includes(e.id)));
    expect((await readOrganizeCandidates(uid, pid)).entries).toEqual([]);
    await getPool().query("UPDATE agent_memory_entry SET organization_checked_at=now()-interval '2 days' WHERE id=$1", [old]);
    expect((await readOrganizeCandidates(uid, pid)).checked).toContain(old);
  });
});

describe("大组摘要可持续推进", () => {
  it("201条分批保存检查点；恢复后提交完整摘要，未完成摘要不会注入", async () => {
    const g = await makeGroup(201);
    expect(await summarizeMemoryGroup(uid, pid, g.groupId, g.revision)).toBe(false);
    expect(llm).toHaveBeenCalledTimes(8);
    expect((await readSummaryProgress(uid, pid, g.groupId, g.revision)).progress?.offset).toBe(40);
    expect((await readMemoryGroups(uid, pid, [g.ids[0]]))[0]).toMatchObject({ summary: null, summaryPending: true, entries: [] });
    // 模拟重入；不复用上一次调用的内存变量。
    let complete = false;
    for (let i = 0; i < 6 && !complete; i++) complete = await summarizeMemoryGroup(uid, pid, g.groupId, g.revision);
    expect(complete).toBe(true);
    expect(llm).toHaveBeenCalledTimes(41);
    const resumed = JSON.parse(llm.mock.calls[8][0][1].content);
    expect(resumed[0]).toMatchObject({ previousSummary: "各方说法尚待核对", previousCoveredEntries: 40 });
    expect((await readSummaryProgress(uid, pid, g.groupId, g.revision)).progress).toBeNull();
    expect((await readMemoryGroups(uid, pid, [g.ids[0]]))[0].summaryPending).toBe(false);
  }, 30_000);

  it("超过100条关系时完整分页，未读完关系不会前进到下一批条目", async () => {
    const g = await makeGroup(107, true);
    const first = await readGroupPage(uid, pid, g.groupId, g.revision, 0);
    expect(first.group.relations).toHaveLength(100);
    expect(first.nextOffset).toBe(0);
    expect(first.nextRelationAfter).toEqual(expect.any(String));
    const second = await readGroupPage(uid, pid, g.groupId, g.revision, first.nextOffset!, first.nextRelationAfter);
    expect(second.nextOffset).toBe(5);
    expect(second.nextRelationAfter).toBeNull();
    expect(new Set([...first.group.relations, ...second.group.relations].map(r => r.id)).size).toBe(106);
    let complete = false;
    for (let i = 0; i < 4 && !complete; i++) complete = await summarizeMemoryGroup(uid, pid, g.groupId, g.revision);
    expect(complete).toBe(true);
    const continuation = JSON.parse(llm.mock.calls[1][0][1].content);
    expect(continuation[0].previousCoveredEntries).toBe(5);
    const coveredRelations = new Set(llm.mock.calls.flatMap(call => {
      const materials = JSON.parse(call[0][1].content);
      return materials.at(-1).relations.map((r: { id: string }) => r.id);
    }));
    expect(coveredRelations.size).toBe(106);
  });

  it("检查点不能回退，正文变化立即使旧检查点失效", async () => {
    const g = await makeGroup(6);
    const next = { offset: 5, relationAfter: null, summary: "已读前五条" };
    expect(await saveSummaryProgress(uid, pid, g.groupId, g.revision, null, next)).toBe(true);
    expect(await saveSummaryProgress(uid, pid, g.groupId, g.revision, null, { ...next, summary: "并发旧摘要" })).toBe(false);
    await mutateMemoryEntry(uid, pid, { action: "update", id: g.ids[0], revision: 0, actor: "agent", body: "条件已更新", brief: "新条件" });
    await expect(readSummaryProgress(uid, pid, g.groupId, g.revision)).rejects.toThrow(/已变化/);
    expect((await readSummaryProgress(uid, pid, g.groupId, g.revision + 1)).progress).toBeNull();
  });

  it("摘要中途失败保留已完成页，下次从检查点恢复", async () => {
    const g = await makeGroup(16);
    llm.mockResolvedValueOnce({ value: "前五条" }).mockRejectedValueOnce(new Error("模型暂时不可用"));
    await expect(summarizeMemoryGroup(uid, pid, g.groupId, g.revision)).rejects.toThrow(/模型暂时/);
    expect((await readSummaryProgress(uid, pid, g.groupId, g.revision)).progress?.offset).toBe(5);
    expect(await summarizeMemoryGroup(uid, pid, g.groupId, g.revision)).toBe(true);
    expect(JSON.parse(llm.mock.calls[2][0][1].content)[0]).toMatchObject({ previousSummary: "前五条", previousCoveredEntries: 5 });
  });
});

describe("后台执行接线", () => {
  it("摘要任务耗尽单批预算后，自动派发不同游标的续批任务", async () => {
    const g = await makeGroup(46);
    await getJobHandlerDef("memory_summary")!.run({ userId: uid, productionId: pid, groupId: g.groupId, revision: g.revision }, {} as never);
    const jobs = (await getPool().query("SELECT kind,payload,dedupe_key FROM job WHERE payload->>'userId'=$1", [uid])).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupe_key).toContain(":40:");
    await getJobHandlerDef("memory_summary")!.run(jobs[0].payload, {} as never);
    expect(llm).toHaveBeenCalledTimes(10);
    expect((await readMemoryGroups(uid, pid, [g.ids[0]]))[0].summaryPending).toBe(false);
  });

  it("高水位保存只入持久队列，不同步调用LLM；工作任务仍负责整理再淘汰", async () => {
    for (let i = 0; i < 36; i++) await create(`后台条目${i}`);
    llm.mockResolvedValue({ value: [] });
    await enqueueMemoryMaintenance(uid, pid);
    expect(llm).not.toHaveBeenCalled();
    const jobs = (await getPool().query("SELECT kind,payload,status FROM job WHERE payload->>'userId'=$1", [uid])).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "memory_maintenance", status: "queued" });
    await getJobHandlerDef("memory_maintenance")!.run(jobs[0].payload, {} as never);
    expect(llm).toHaveBeenCalledTimes(1);
    expect((await readMemoryGroups(uid, pid)).reduce((n, group) => n + group.memberCount, 0)).toBe(24);
    const registry = readFileSync("lib/job/handlers.ts", "utf8");
    expect(registry).toContain('"memory_maintenance", "memory_summary"');
    expect(readFileSync("lib/agent/runtime/memory-tools.ts", "utf8")).toContain("await enqueueMemoryMaintenance");
    expect(readFileSync("app/api/account/memories/route.ts", "utf8")).toContain("enqueueMemoryMaintenance");
  });
});
