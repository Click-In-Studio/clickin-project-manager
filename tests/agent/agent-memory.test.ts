import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { Pool } from "pg";
import { getPool, poolConfigFromEnv } from "@/lib/pg";
import { appendRunRecord } from "@/lib/agent/memory/store";
import { readMemoryScope, mutateMemoryEntry, readDreamSnapshot, commitDream, MemoryAccessError, MemoryConflictError } from "@/lib/agent/memory/memory-db";
import { buildInjectContext } from "@/lib/agent/memory/inject";
import { distillUser, parseDreamOutput } from "@/lib/agent/memory/distill";
import { searchMemory } from "@/lib/agent/memory/search";
const chatMock = vi.fn(async (..._args: unknown[]) => '["简短说明"]');
vi.mock("@/lib/agent/llm-chat", async original => ({
  ...(await original<typeof import("@/lib/agent/llm-chat")>()), chat: (...args: unknown[]) => chatMock(...args),
}));
let userId: string;
let owner: string;
let prodId: string;
let otherProd: string;
const now = () => new Date().toISOString();
beforeAll(async () => {
  userId = (await upsertFeishuUser(`memory-${shortId()}`, "记忆用户", null, false)).userId;
  owner = (await upsertFeishuUser(`memory-owner-${shortId()}`, "项目owner", null, false)).userId;
  ({ prodId } = await makeProduction(owner));
  ({ prodId: otherProd } = await makeProduction(userId));
  await addProductionMember(prodId, userId);
});
beforeEach(async () => {
  await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [userId]);
  await getPool().query("DELETE FROM agent_memory_chunk WHERE scope_id=$1", [userId]);
  chatMock.mockReset().mockResolvedValue('["简短说明"]');
  process.env.EMBEDDING_PROVIDER = "none";
});
afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProd).catch(() => {});
  await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [userId]);
  await getPool().query("DELETE FROM agent_memory_chunk WHERE scope_id=$1", [userId]);
  delete process.env.EMBEDDING_PROVIDER;
});
const create = (body: string, pid: string | null = null, actor: "user" | "agent" = "user") => mutateMemoryEntry(userId, pid, { action: "create", body, actor });
const archive = (text: string, pid: string | null = null, ts = now()) => appendRunRecord(userId, { ts, productionId: pid, lastUser: text, lastAssistant: "收到" });

describe("作用域与常驻注入", () => {
  it("个人通用和当前项目分别注入；别的项目和近期做法不默认进入", async () => {
    await create("先给结论");
    await create("这个项目 Magnum 枪声保持低音量", prodId);
    await create("另一个项目要求枪声高音量", otherProd);
    await archive("曾经调研过Magnum", otherProd);
    await archive("本项目另一会话的旧方案", prodId);
    await commitDream(await readDreamSnapshot(userId, prodId, 24000), ["长期保留的排练偏好"]);
    const current = await buildInjectContext(userId, `clickin:chat:${userId}:${prodId}:11111111-2222-3333-4444-555555555555`, "Magnum");
    expect(current.memory).toContain("先给结论");
    expect(current.memory).toContain("保持低音量");
    expect(current.memory).not.toContain("高音量");
    expect(current.memory).not.toContain("曾经调研");
    expect(current.memory).not.toContain("本项目另一会话的旧方案");
    expect(current.memory).not.toContain("近期对话");
    expect(current.memory).toContain("长期保留的排练偏好");
    expect((await searchMemory(userId, "本项目另一会话的旧方案", prodId)).hits.some(h => h.text.includes("本项目另一会话的旧方案"))).toBe(true);
    expect(current.recall ?? "").not.toContain("曾经调研");
    expect((await buildInjectContext(userId)).memory).not.toContain("保持低音量");
    expect((await readDreamSnapshot(userId, null, 24000)).inputs).toHaveLength(2);
  });
  it("小批次只消费已读取历史，余下历史不丢失", async () => {
    await archive("第一批".repeat(20)); await archive("第二批".repeat(20));
    const first = await readDreamSnapshot(userId, null, 1);
    expect(first.inputs).toHaveLength(1);
    await commitDream(first, ["旧摘要"]);
    const second = await readDreamSnapshot(userId, null, 1);
    expect(second.inputs[0].text).toContain("第二批");
    await commitDream(second, ["新摘要"]);
    expect((await readDreamSnapshot(userId, null, 1000)).inputs).toHaveLength(0);
  });
});
describe("按条目编辑删除与旧来源隔离", () => {
  it("删除后旧批次拒绝提交，其他条目保留，旧归档再次回填也不可复活", async () => {
    const ts = now();
    await archive("旧枪声方案", prodId, ts);
    const snapshot = await readDreamSnapshot(userId, prodId, 24000);
    await commitDream(snapshot, ["旧枪声方案", "保留的职责"]);
    await archive("整理正在进行", prodId);
    const inFlight = await readDreamSnapshot(userId, prodId, 24000);
    await commitDream(await readDreamSnapshot(userId, null, 24000), ["从这个项目产生的通用自动摘要"]);
    await create("用户保留的通用要求");
    const scope = await readMemoryScope(userId, prodId);
    const old = scope.entries.find(e => e.body === "旧枪声方案")!;
    await mutateMemoryEntry(userId, prodId, { action: "delete", id: old.id, revision: old.revision, actor: "user" });
    expect(await commitDream(inFlight, ["旧枪声方案"])).toBe(false);
    expect((await readMemoryScope(userId, null)).entries.map(e => e.body)).toEqual(["用户保留的通用要求"]);
    await archive("旧枪声方案", prodId, ts);
    expect((await readDreamSnapshot(userId, prodId, 24000)).inputs).toHaveLength(0);
    expect((await searchMemory(userId, "旧枪声方案", prodId)).hits).toHaveLength(0);
    expect((await readMemoryScope(userId, prodId)).entries.map(e => e.body)).toEqual(["保留的职责"]);
    await archive("新对话要求新的枪声方案", prodId, new Date(Date.now() + 1000).toISOString());
    expect((await readDreamSnapshot(userId, prodId, 24000)).inputs).toHaveLength(1);
  });
  it("用户更正和主动条目不会被 dream 或 AI 更新覆盖；旧会话不能新增", async () => {
    await archive("需要整理");
    await commitDream(await readDreamSnapshot(userId, null, 24000), ["原偏好"]);
    const old = (await readMemoryScope(userId, null)).entries[0];
    await mutateMemoryEntry(userId, null, { action: "update", id: old.id, revision: old.revision, body: "用户更正", actor: "user" });
    const edited = (await readMemoryScope(userId, null)).entries[0];
    await expect(mutateMemoryEntry(userId, null, { action: "update", id: old.id, revision: edited.revision, body: "模型推断", actor: "agent" })).rejects.toThrow();
    await expect(create("旧会话的新副本", null, "agent")).rejects.toThrow(/旧会话/);
    await create("主动保护");
    await archive("新的整理材料", null, new Date(Date.now()+1000).toISOString());
    await commitDream(await readDreamSnapshot(userId, null, 24000), ["另一个偏好"]);
    expect((await readMemoryScope(userId, null)).entries.map(e => e.body)).toEqual(expect.arrayContaining(["用户更正", "主动保护", "另一个偏好"]));
    await expect(mutateMemoryEntry(userId, null, { action: "update", id: old.id, revision: old.revision, body: "陈旧编辑", actor: "user" })).rejects.toThrow(/已变化/);
  });
  it("两个并发编辑只有一份成功，旧 revision 不会覆盖新内容", async () => {
    const original = getPool();
    const narrow = new Pool({ ...poolConfigFromEnv(), max: 2, connectionTimeoutMillis: 200 });
    const poolGlobal = global as typeof globalThis & { __pgPool?: Pool };
    // 换真实连接池，不替换查询；CI 默认池也必须覆盖两条连接的饥饿分支。
    poolGlobal.__pgPool = narrow;
    try {
      const id = await create("并发编辑前", prodId);
      const results = await Promise.allSettled(["编辑甲", "编辑乙"].map(body => mutateMemoryEntry(userId, prodId, { action: "update", id, revision: 0, body, actor: "user" })));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter(r => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(MemoryConflictError);
      expect((await readMemoryScope(userId, prodId)).entries[0].revision).toBe(1);
    } finally {
      poolGlobal.__pgPool = original;
      await narrow.end();
    }
  });
  it("一般范围删除也阻止旧项目历史检索；仅项目删除不清其他项目", async () => {
    await archive("其他项目历史", otherProd);
    const id = await create("待删除", prodId);
    await mutateMemoryEntry(userId, prodId, { action: "delete", id, revision: 0, actor: "user" });
    expect((await searchMemory(userId, "其他项目历史")).hits).toHaveLength(1);
    const global = await create("通用待删除");
    await mutateMemoryEntry(userId, null, { action: "delete", id: global, revision: 0, actor: "user" });
    expect((await searchMemory(userId, "其他项目历史")).hits).toHaveLength(0);
  });
  it("整理期间成员被移出，不能再提交、读取、注入或搜索项目记忆", async () => {
    await create("项目内部约束", prodId); await archive("项目历史", prodId);
    const snapshot = await readDreamSnapshot(userId, prodId, 24000);
    await commitDream(await readDreamSnapshot(userId, null, 24000), ["跨项目明确的通用习惯"]);
    await create("用户明确编辑的通用要求");
    await getPool().query("UPDATE production_member SET status='exited',status_source='self' WHERE production_id=$1 AND user_id=$2", [prodId, userId]);
    try {
      await expect(commitDream(snapshot, ["项目历史"])).rejects.toBeInstanceOf(MemoryAccessError);
      await expect(readMemoryScope(userId, prodId)).rejects.toBeInstanceOf(MemoryAccessError);
      const general = await readMemoryScope(userId, null);
      expect(general.entries.map(e => e.body)).toEqual(["用户明确编辑的通用要求"]);
      expect((await searchMemory(userId, "项目历史")).hits).toHaveLength(0);
      const injected = await buildInjectContext(userId, `clickin:chat:${userId}:${prodId}:11111111-2222-3333-4444-555555555555`);
      expect(injected.memory).not.toContain("项目内部约束");
    } finally { await getPool().query("UPDATE production_member SET status='active',status_source=NULL WHERE production_id=$1 AND user_id=$2", [prodId, userId]); }
  });
});
describe("整理与幻觉控制", () => {
  it("不接受模型自报来源、用户确认或分数", () => {
    expect(() => parseDreamOutput('[{"body":"偏好","source":"某句话","userEdited":true}]')).toThrow();
    expect(() => parseDreamOutput('[" "]')).toThrow();
  });
  it("输入和基线组成整理批次；服务端只记录批次数量，不制造事实证据", async () => {
    await create("主动要求", null, "agent"); await archive("新的偏好");
    expect((await distillUser(userId)).status).toBe("distilled");
    const entries = (await readMemoryScope(userId, null)).entries;
    expect(entries.find(e => e.source === "dream")).toMatchObject({ userEdited: false, inputCount: 1 });
    expect(entries.find(e => e.source === "active")?.body).toBe("主动要求");
    expect(JSON.stringify(chatMock.mock.calls.at(-1))).toContain("主动要求");
    expect((await distillUser(userId)).status).toBe("no-new-data");
  });
  it("非预算失败不消费，预算溢出逐级缩小批次", async () => {
    await archive("重试材料");
    chatMock.mockRejectedValueOnce(new Error("provider down"));
    expect((await distillUser(userId)).status).toBe("error");
    const { LlmBudgetError } = await import("@/lib/agent/llm-chat");
    chatMock.mockRejectedValueOnce(new LlmBudgetError("length", false));
    expect(await distillUser(userId)).toMatchObject({ status: "distilled", inputChars: 12000, shrunk: true });
  });
});
