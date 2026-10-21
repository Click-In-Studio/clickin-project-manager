import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { readFileSync } from "node:fs";
import {
  makeProduction,
  cleanupProduction,
  shortId,
} from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { getPool } from "@/lib/pg";
import {
  mutateMemoryEntry,
  readMemoryScope,
  MemoryConflictError,
} from "@/lib/agent/memory/memory-db";
import {
  addMemoryRelations,
  readMemoryGroups,
  evictMemoryCache,
  touchMemory,
  commitGroupSummary,
} from "@/lib/agent/memory/memory-group-db";
import { resolveMemoryGroup } from "@/lib/agent/memory/memory-resolve-db";
import { searchMemoryGroups } from "@/lib/agent/memory/memory-search-db";
import { connectedComponents } from "@/lib/agent/memory/memory-graph";
import { buildInjectContext } from "@/lib/agent/memory/inject";
import {
  organizeMemoryScope,
  parseRelations,
  summarizeMemoryGroup,
} from "@/lib/agent/memory/organize";
import { MEMORY_GROUP_BRIEF_MAX } from "@/lib/agent/memory/memory-types";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
const llm = vi.fn();
vi.mock("@/lib/agent/llm-chat", () => ({
  chat: (...args: unknown[]) => llm(...args),
}));
let uid: string, pid: string, other: string;
beforeAll(async () => {
  uid = (
    await upsertFeishuUser(`memory-1034-${shortId()}`, "记忆工厂", null, false)
  ).userId;
  ({ prodId: pid } = await makeProduction(uid));
  ({ prodId: other } = await makeProduction(uid));
});
beforeEach(async () => {
  process.env.EMBEDDING_PROVIDER = "none";
  await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [
    uid,
  ]);
  llm
    .mockReset()
    .mockResolvedValue({ value: [], provider: "test", model: "test" });
});
afterAll(async () => {
  await cleanupProduction(pid).catch(() => {});
  await cleanupProduction(other).catch(() => {});
  await getPool().query("DELETE FROM agent_memory_scope WHERE user_id=$1", [
    uid,
  ]);
  delete process.env.EMBEDDING_PROVIDER;
});
const create = (body: string, project: string | null = pid, brief = body) =>
  mutateMemoryEntry(uid, project, {
    action: "create",
    actor: "agent",
    body,
    brief,
  });
const link = (a: string, b: string) =>
  addMemoryRelations(uid, pid, [
    {
      leftId: a,
      rightId: b,
      kind: "conflict",
      reason: "同一项目的采用约定待核对",
    },
  ]);

describe("连通分量与组读写", () => {
  it("环、链、孤立节点，连通不制造新边", () => {
    expect(
      connectedComponents(
        ["a", "b", "c", "d"],
        [
          { leftId: "a", rightId: "b" },
          { leftId: "b", rightId: "c" },
          { leftId: "c", rightId: "a" },
        ],
      ),
    ).toEqual([["a", "b", "c"], ["d"]]);
  });
  it("AB/BC共同返回与搜索，不生成AC关系，解除桥接后局部拆组", async () => {
    const a = await create("采用甲表"),
      b = await create("采用乙表"),
      c = await create("采用丙表");
    await link(a, b);
    await link(b, c);
    const groups = await readMemoryGroups(uid, pid, [a]);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((e) => e.id).sort()).toEqual([a, b, c].sort());
    expect(groups[0].relations).toHaveLength(2);
    expect(
      (await searchMemoryGroups(uid, pid, "采用甲表"))[0].entries,
    ).toHaveLength(3);
    const edge = groups[0].relations.find((r) =>
      [r.leftId, r.rightId].includes(c),
    )!;
    await resolveMemoryGroup(uid, pid, {
      groupId: groups[0].id,
      revision: groups[0].revision,
      relationIds: [edge.id],
      changes: [],
      reason: "丙属于另一场次，解除误判",
    });
    expect((await readMemoryGroups(uid, pid, [a]))[0].memberCount).toBe(2);
    expect((await readMemoryGroups(uid, pid, [c]))[0].memberCount).toBe(1);
    await link(b, c);
    expect((await readMemoryGroups(uid, pid, [a]))[0].memberCount).toBe(2);
  });
  it("删环上一条边仍连通；删除桥接节点后没有悬空关联", async () => {
    const a = await create("甲"),
      b = await create("乙"),
      c = await create("丙");
    await link(a, b);
    await link(b, c);
    await link(a, c);
    let g = (await readMemoryGroups(uid, pid, [a]))[0];
    await resolveMemoryGroup(uid, pid, {
      groupId: g.id,
      revision: g.revision,
      relationIds: [
        g.relations.find(
          (r) =>
            [r.leftId, r.rightId].includes(a) &&
            [r.leftId, r.rightId].includes(b),
        )!.id,
      ],
      changes: [],
      reason: "不是冲突",
    });
    g = (await readMemoryGroups(uid, pid, [a]))[0];
    expect(g.memberCount).toBe(3);
    await mutateMemoryEntry(uid, pid, {
      action: "delete",
      id: c,
      revision: 0,
      actor: "agent",
    });
    expect((await readMemoryGroups(uid, pid, [a]))[0].memberCount).toBe(1);
    expect((await readMemoryGroups(uid, pid, [b]))[0].memberCount).toBe(1);
  });
  it("跨作用域关系、读取和touch拒绝；权限由owner/成员实时判断", async () => {
    const a = await create("项目甲"),
      b = await create("另项目", other);
    await expect(link(a, b)).rejects.toThrow(/同一范围/);
    await expect(readMemoryGroups(uid, other, [a])).rejects.toThrow(/范围/);
    await expect(touchMemory(uid, other, [a])).rejects.toThrow(/范围/);
    await expect(
      readMemoryGroups("00000000-0000-0000-0000-000000006103", pid),
    ).rejects.toThrow(/访问资格/);
    await expect(
      getPool().query(
        "INSERT INTO agent_memory_relation(id,scope_id,left_entry_id,right_entry_id,kind,reason,left_revision,right_revision) SELECT 'bad-cross-1034',scope_id,LEAST($1,$2),GREATEST($1,$2),'conflict','跨域',0,0 FROM agent_memory_entry WHERE id=$1",
        [a, b],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
describe("缓存、水位与内容生命周期", () => {
  it("整组evict/重新touch；touch不改正文修订/产生时间或摘要", async () => {
    const a = await create("旧甲"),
      b = await create("旧乙");
    await link(a, b);
    const before = (await readMemoryScope(uid, pid)).entries.find(
      (e) => e.id === a,
    )!;
    const group = (await readMemoryGroups(uid, pid, [a]))[0];
    await commitGroupSummary(
      uid,
      pid,
      group.id,
      group.revision,
      "保留双方说法",
    );
    await create("新丙");
    await create("新丁");
    const evicted = await evictMemoryCache(uid, pid, 2, 4);
    expect(evicted).toContain(group.id);
    expect(
      (await readMemoryGroups(uid, pid)).flatMap((g) =>
        g.entries.map((e) => e.id),
      ),
    ).not.toContain(a);
    await touchMemory(uid, pid, [a]);
    expect(
      (await readMemoryGroups(uid, pid)).find((g) => g.id === group.id)
        ?.memberCount,
    ).toBe(2);
    const after = (await readMemoryScope(uid, pid)).entries.find(
      (e) => e.id === a,
    )!;
    expect(after).toMatchObject({
      body: before.body,
      revision: before.revision,
      createdAt: before.createdAt,
    });
    const db = (
      await getPool().query(
        "SELECT revision,summary,summary_revision FROM agent_memory_group WHERE id=$1",
        [group.id],
      )
    ).rows[0];
    expect(db.summary).toBe("保留双方说法");
    expect(db.revision).toBe(db.summary_revision);
  });
  it("缓存只注入brief，其他项目及历史不混入；冷条目联合检索可补足且不touch", async () => {
    const a = await create("这是正文细节", "" + pid, "音响采用约定");
    await create("别的项目机密", other);
    await getPool().query(
      "UPDATE agent_memory_group SET in_cache=false WHERE id=(SELECT group_id FROM agent_memory_entry WHERE id=$1)",
      [a],
    );
    const before = (
      await getPool().query(
        "SELECT last_touched_at FROM agent_memory_group WHERE id=(SELECT group_id FROM agent_memory_entry WHERE id=$1)",
        [a],
      )
    ).rows[0].last_touched_at;
    const inject = await buildInjectContext(
      uid,
      createNewSessionKey(uid, pid),
      "音响采用约定",
    );
    expect(inject.memory).toContain("音响采用约定");
    expect(inject.memory).not.toContain("这是正文细节");
    expect(inject.memory).not.toContain("别的项目机密");
    expect(
      (
        await getPool().query(
          "SELECT last_touched_at FROM agent_memory_group WHERE id=(SELECT group_id FROM agent_memory_entry WHERE id=$1)",
          [a],
        )
      ).rows[0].last_touched_at,
    ).toEqual(before);
  });
  it("陈旧修订/摘要拒绝；用户编辑保护；删除可恢复且搜索不返回墓碑", async () => {
    const id = await create("老约定");
    const g = (await readMemoryGroups(uid, pid, [id]))[0];
    await mutateMemoryEntry(uid, pid, {
      action: "update",
      id,
      revision: 0,
      body: "新约定",
      brief: "新约定",
      actor: "agent",
    });
    expect(
      await commitGroupSummary(uid, pid, g.id, g.revision, "过期摘要"),
    ).toBe(false);
    const results = await Promise.allSettled(
      ["甲改", "乙改"].map((body) =>
        mutateMemoryEntry(uid, pid, {
          action: "update",
          id,
          revision: 1,
          body,
          actor: "user",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ).toBeInstanceOf(MemoryConflictError);
    await expect(
      mutateMemoryEntry(uid, pid, {
        action: "delete",
        id,
        revision: 2,
        actor: "agent",
      }),
    ).rejects.toThrow(/旧会话/);
    await mutateMemoryEntry(uid, pid, {
      action: "delete",
      id,
      revision: 2,
      actor: "user",
    });
    expect(await searchMemoryGroups(uid, pid, "约定")).toEqual([]);
    expect((await readMemoryScope(uid, pid)).deletedEntries).toHaveLength(1);
    await mutateMemoryEntry(uid, pid, {
      action: "restore",
      id,
      revision: 3,
      actor: "user",
    });
    expect((await readMemoryScope(uid, pid)).entries[0].id).toBe(id);
  });
});
describe("核对提交与水位接线", () => {
  it("合并保留条目原始时间，删除副本；旧整理输入不能重建关系", async () => {
    const a = await create("采用甲表，范围为音响"),
      b = await create("采用甲表，范围还包括音乐");
    await link(a, b);
    const before = (await readMemoryScope(uid, pid)).entries.find(
      (e) => e.id === a,
    )!;
    const g = (await readMemoryGroups(uid, pid, [a]))[0];
    await resolveMemoryGroup(uid, pid, {
      groupId: g.id,
      revision: g.revision,
      relationIds: g.relations.map((e) => e.id),
      reason: "同一采用约定，合并范围",
      changes: [
        {
          id: a,
          revision: 0,
          body: "音响与音乐均采用甲表",
          brief: "音响与音乐均采用甲表",
        },
        { id: b, revision: 0, remove: true },
      ],
    });
    const after = await readMemoryScope(uid, pid);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({
      body: "音响与音乐均采用甲表",
      createdAt: before.createdAt,
    });
    expect((await readMemoryGroups(uid, pid, [a]))[0].relations).toHaveLength(
      0,
    );
    await expect(
      addMemoryRelations(
        uid,
        pid,
        [{ leftId: a, rightId: b, kind: "duplicate", reason: "旧快照" }],
        { [a]: 0, [b]: 0 },
      ),
    ).rejects.toThrow(/输入已变化/);
  });
  it("高水位先整理再整组回落，未到阈值不调用LLM", async () => {
    const { maintainMemoryCache } = await import("@/lib/agent/memory/organize");
    for (let i = 0; i < 35; i++) await create(`缓存条目${i}`);
    await maintainMemoryCache(uid, pid);
    expect(llm).not.toHaveBeenCalled();
    await create("触发第36条");
    await maintainMemoryCache(uid, pid);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(
      (await readMemoryGroups(uid, pid)).reduce((n, g) => n + g.memberCount, 0),
    ).toBe(24);
    expect((await readMemoryScope(uid, pid)).entries).toHaveLength(36);
  });
  it("用户编辑保护不能被无来源的Agent删除绕过", async () => {
    const id = await mutateMemoryEntry(uid, pid, {
      action: "create",
      actor: "user",
      body: "用户保留的约定",
    });
    await expect(
      mutateMemoryEntry(uid, pid, {
        action: "delete",
        actor: "agent",
        id,
        revision: 0,
      }),
    ).rejects.toThrow(/用户编辑/);
  });
  it("高水位索引失败仍整组回落，不因外部服务失败突破缓存水位", async () => {
    for (let i = 0; i < 36; i++) await create(`索引故障时的条目${i}`);
    const { maintainMemoryCache } = await import("@/lib/agent/memory/organize");
    const searchDb = await import("@/lib/agent/memory/memory-search-db");
    const indexer = vi
      .spyOn(searchDb, "indexMemoryEntries")
      .mockRejectedValue(new Error("索引服务暂不可用"));
    try {
      await expect(maintainMemoryCache(uid, pid)).rejects.toThrow(/索引服务/);
      expect(
        (await readMemoryGroups(uid, pid)).reduce(
          (n, g) => n + g.memberCount,
          0,
        ),
      ).toBe(24);
      expect((await readMemoryScope(uid, pid)).entries).toHaveLength(36);
    } finally {
      indexer.mockRestore();
    }
  });
});

describe("整理接线与防偏", () => {
  it("分页摘要累计覆盖正文，最后一页不沿用前批未完整状态", async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await create(`待核对原文${i}`));
    for (let i = 1; i < ids.length; i++) await link(ids[i - 1], ids[i]);
    const g = (await readMemoryGroups(uid, pid, [ids[0]]))[0];
    expect(g.summaryPending).toBe(true);
    const inputs: Array<Array<Record<string, unknown>>> = [];
    llm.mockImplementation(async (messages: Array<{ content: string }>) => {
      const materials = JSON.parse(messages[1].content);
      inputs.push(materials);
      return {
        value:
          inputs.length === 1
            ? "已读5条，末条正文待补"
            : "6条原文均已处理，分歧尚未解决",
      };
    });
    expect(await summarizeMemoryGroup(uid, pid, g.id, g.revision)).toBe(true);
    expect(inputs[0][0].coverage).toEqual({
      offset: 0,
      currentEntries: 5,
      coveredEntries: 5,
      totalEntries: 6,
      complete: false,
    });
    expect(inputs[1][0]).toMatchObject({
      previousSummary: "已读5条，末条正文待补",
      previousCoveredEntries: 5,
    });
    expect(inputs[1][1].coverage).toEqual({
      offset: 5,
      currentEntries: 1,
      coveredEntries: 6,
      totalEntries: 6,
      complete: true,
    });
    const result = (await readMemoryGroups(uid, pid, [ids[0]]))[0];
    expect(result.summary).toBe("6条原文均已处理，分歧尚未解决");
    expect(result.memberCount).toBe(6);
    expect(result.entries).toEqual([]);
  });
  it("整理只建候选关系，不改写事实，重复扫描不反复提升", async () => {
    const a = await create("采用音响表v1"),
      b = await create("采用音响表v2");
    llm.mockResolvedValue({
      value: [
        {
          leftId: a,
          rightId: b,
          kind: "duplicate",
          reason: "采用来源有变更线索，待主模型核对",
        },
      ],
    });
    await organizeMemoryScope(uid, pid);
    const g = (await readMemoryGroups(uid, pid, [a]))[0];
    expect(g.entries).toHaveLength(2);
    expect(
      (await readMemoryScope(uid, pid)).entries.map((e) => e.body),
    ).toEqual(["采用音响表v1", "采用音响表v2"]);
    await organizeMemoryScope(uid, pid);
    expect((await readMemoryGroups(uid, pid, [a]))[0].lastTouchedAt).toBe(
      g.lastTouchedAt,
    );
    expect(readFileSync("lib/agent/memory/organize.ts", "utf8")).not.toContain(
      "readDreamSnapshot",
    );
    expect(() =>
      parseRelations(
        '[{"leftId":"a","rightId":"a","kind":"conflict","reason":"x"}]',
      ),
    ).toThrow();
  });
  it("超限组不泄露单方brief；新内容使摘要失效", async () => {
    const ids = [];
    for (let i = 0; i < 10; i++)
      ids.push(await create(`原文${i}`, pid, `${i}` + "条件".repeat(140)));
    for (let i = 1; i < ids.length; i++) await link(ids[0], ids[i]);
    let g = (await readMemoryGroups(uid, pid, [ids[0]]))[0];
    expect(g.entries).toEqual([]);
    expect(g.summaryPending).toBe(true);
    expect(
      await commitGroupSummary(
        uid,
        pid,
        g.id,
        g.revision,
        "双方说法需要核对，少数观点仍保留",
      ),
    ).toBe(true);
    g = (await readMemoryGroups(uid, pid, [ids[0]]))[0];
    expect(g.summary).toContain("少数观点");
    expect(g.entries).toEqual([]);
    await mutateMemoryEntry(uid, pid, {
      action: "update",
      id: ids[0],
      revision: 0,
      body: "新说法",
      brief: "新条件".repeat(90),
      actor: "agent",
    });
    expect((await readMemoryGroups(uid, pid, [ids[1]]))[0].summaryPending).toBe(
      true,
    );
    expect(MEMORY_GROUP_BRIEF_MAX).toBeGreaterThan(0);
  });
});
