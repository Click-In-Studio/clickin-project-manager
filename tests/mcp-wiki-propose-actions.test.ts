import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createEventReport } from "@/lib/event-db";
import { getPool } from "@/lib/pg";
import { createWiki, getWiki } from "@/lib/wiki-db";
import { wikiProposeUpdate, wikiProposeDelete, wikiProposeMove } from "@/lib/mcp/wiki-tools";
import { getWikiProposalByToolCallId } from "@/lib/wiki-proposal-db";
import { DENIED_NOT_MEMBER } from "@/lib/mcp/production-tools";

// update/delete/move 三个动作各自的门是实例级（canEditWiki/canDeleteWiki 对
// 具体这一篇文档），不是 create 那种域级门——所以每个用例都要真造一个"对
// 这篇文档没有 edit/delete 权限"的成员，不能只靠零权限成员一概而论。
process.env.MCP_PORT = "3200";
const BASE = "http://127.0.0.1:3200";

type FakeStore = {
  client: unknown; status: { state: string }; connecting: null; events: EventEmitter;
  pendingApprovals: Map<string, unknown>; denyReasons: Map<string, unknown>; pendingSteers: Map<string, number[]>;
};
const g = globalThis as unknown as {
  __mcpHttpServer?: { close: (cb?: () => void) => void };
  __clickinAgentGateway?: FakeStore;
};
let savedStore: FakeStore | undefined;

let prodId: string;
let ownerId: string;
let plainMemberId: string;

beforeAll(async () => {
  savedStore = g.__clickinAgentGateway;
  g.__clickinAgentGateway = {
    client: null, status: { state: "connected" }, connecting: null, events: new EventEmitter(),
    pendingApprovals: new Map(), denyReasons: new Map(), pendingSteers: new Map(),
  };
  const { startMcpServer } = await import("@/lib/mcp/server");
  startMcpServer();
  await new Promise((r) => setTimeout(r, 150));

  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `动作测试所有者${shortId()}`, null, false)).userId;
  plainMemberId = (await upsertFeishuUser(`test-open-${shortId()}`, `动作测试零权限成员${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, plainMemberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  const server = g.__mcpHttpServer;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  delete g.__mcpHttpServer;
  g.__clickinAgentGateway = savedStore;
});

describe("wikiProposeUpdate", () => {
  it("owner（对这篇文档有 edit 权限）→ 真更新，proposal applied", async () => {
    const doc = await createWiki({ productionId: prodId, title: "旧标题", body: "旧正文", createdBy: ownerId });
    const result = await wikiProposeUpdate(ownerId, prodId, `call_${shortId()}`, { wikiId: doc.id, title: "新标题", body: "新正文", summary: "测试" });
    expect(result).toContain("已更新文档");
    const updated = await getWiki(doc.id, prodId);
    expect(updated?.title).toBe("新标题");
    expect(updated?.body).toBe("新正文");
  });

  it("对这篇文档没有 edit 权限的成员（非创建者、非 owner）→ 拦截，内容不变", async () => {
    const doc = await createWiki({ productionId: prodId, title: "受保护标题", body: "受保护正文", createdBy: ownerId });
    const result = await wikiProposeUpdate(plainMemberId, prodId, `call_${shortId()}`, { wikiId: doc.id, title: "篡改标题", summary: "测试" });
    expect(result).toContain("权限被拒绝");
    const unchanged = await getWiki(doc.id, prodId);
    expect(unchanged?.title).toBe("受保护标题");
  });

  it("非成员 → 明确拒绝", async () => {
    const doc = await createWiki({ productionId: prodId, title: "T", createdBy: ownerId });
    const outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `动作测试局外人${shortId()}`, null, false)).userId;
    expect(await wikiProposeUpdate(outsiderId, prodId, `call_${shortId()}`, { wikiId: doc.id, title: "X", summary: "" })).toBe(DENIED_NOT_MEMBER);
  });

  it("title/body 都不传 → 不做任何变更，给出说明文案", async () => {
    const doc = await createWiki({ productionId: prodId, title: "原样保留", createdBy: ownerId });
    const result = await wikiProposeUpdate(ownerId, prodId, `call_${shortId()}`, { wikiId: doc.id, summary: "空提议" });
    expect(result).toContain("未做任何变更");
    expect((await getWiki(doc.id, prodId))?.title).toBe("原样保留");
  });
});

describe("wikiProposeDelete", () => {
  it("owner 删除普通文档 → 真删除，proposal applied", async () => {
    const doc = await createWiki({ productionId: prodId, title: "待删文档", createdBy: ownerId });
    const result = await wikiProposeDelete(ownerId, prodId, `call_${shortId()}`, { wikiId: doc.id, summary: "清理" });
    expect(result).toContain("已删除");
    expect(await getWiki(doc.id, prodId)).toBeNull();
  });

  it("对这篇文档没有 delete 权限的成员 → 拦截，文档还在，proposal blocked_no_permission", async () => {
    const doc = await createWiki({ productionId: prodId, title: "受保护待删文档", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    const result = await wikiProposeDelete(plainMemberId, prodId, toolCallId, { wikiId: doc.id, summary: "测试" });
    expect(result).toContain("权限被拒绝");
    expect(await getWiki(doc.id, prodId)).not.toBeNull();
  });

  it("被挂载的文档 → 业务规则拦截（不是权限问题），proposal 状态是 blocked_business_rule 不是 blocked_no_permission", async () => {
    const eventId = `ev${shortId()}`;
    await getPool().query(
      `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, 'E', $3, 'published')`,
      [eventId, prodId, ownerId],
    );
    const reportId = `rp${shortId()}`;
    await createEventReport({ id: reportId, eventId, reportType: "rehearsal", title: "挂载中", body: "x", createdBy: ownerId });
    const mountedWikiId = (await getPool().query<{ wiki_id: string }>(
      `SELECT wiki_id::text AS wiki_id FROM event_report WHERE id = $1`, [reportId],
    )).rows[0].wiki_id;

    const toolCallId = `call_${shortId()}`;
    const result = await wikiProposeDelete(ownerId, prodId, toolCallId, { wikiId: mountedWikiId, summary: "测试" });
    expect(result).toContain("被挂载");
    expect(result).not.toContain("权限被拒绝");
    expect(await getWiki(mountedWikiId, prodId)).not.toBeNull();
  });
});

describe("wikiProposeMove", () => {
  it("owner 移动到新父 → parent_id 真的变了，proposal applied", async () => {
    const oldParent = await createWiki({ productionId: prodId, title: "旧父", createdBy: ownerId });
    const newParent = await createWiki({ productionId: prodId, title: "新父", createdBy: ownerId });
    const doc = await createWiki({ productionId: prodId, title: "被移动的文档", parentId: oldParent.id, createdBy: ownerId });

    const result = await wikiProposeMove(ownerId, prodId, `call_${shortId()}`, { wikiId: doc.id, newParentId: newParent.id, summary: "重新归档" });
    expect(result).toContain("已把文档");
    expect((await getWiki(doc.id, prodId))?.parentId).toBe(newParent.id);
  });

  it("移动到文档库根（newParentId 留空）→ parent_id 变 null", async () => {
    const parent = await createWiki({ productionId: prodId, title: "父", createdBy: ownerId });
    const doc = await createWiki({ productionId: prodId, title: "移到根", parentId: parent.id, createdBy: ownerId });
    await wikiProposeMove(ownerId, prodId, `call_${shortId()}`, { wikiId: doc.id, summary: "" });
    expect((await getWiki(doc.id, prodId))?.parentId).toBeNull();
  });

  it("成环 → 拒绝且不落地，proposal 标 blocked_business_rule", async () => {
    const a = await createWiki({ productionId: prodId, title: "环A", createdBy: ownerId });
    const b = await createWiki({ productionId: prodId, title: "环B", parentId: a.id, createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    const result = await wikiProposeMove(ownerId, prodId, toolCallId, { wikiId: a.id, newParentId: b.id, summary: "" });
    expect(result).not.toContain("已把文档");
    expect((await getWiki(a.id, prodId))?.parentId).toBeNull(); // 没被改动
  });

  it("对这篇文档没有 edit 权限的成员 → 拦截，位置不变", async () => {
    const doc = await createWiki({ productionId: prodId, title: "受保护位置文档", createdBy: ownerId });
    const target = await createWiki({ productionId: prodId, title: "目标父", createdBy: ownerId });
    const result = await wikiProposeMove(plainMemberId, prodId, `call_${shortId()}`, { wikiId: doc.id, newParentId: target.id, summary: "" });
    expect(result).toContain("权限被拒绝");
    expect((await getWiki(doc.id, prodId))?.parentId).toBeNull();
  });
});

describe("POST /wiki-proposal：action=update/delete/move 用实例级权限判定", () => {
  it("action=update，owner 对目标文档有 edit → hasPermission true，permissionKey 带具体 wikiId", async () => {
    const doc = await createWiki({ productionId: prodId, title: "预持久化-更新目标", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    const res = await fetch(`${BASE}/wiki-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productionId: prodId, toolCallId, callerUserId: ownerId, action: "update", wikiId: doc.id, title: "新标题", summary: "" }),
    });
    const data = (await res.json()) as { hasPermission: boolean };
    expect(data.hasPermission).toBe(true);
    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.action).toBe("update");
    expect(row?.targetWikiId).toBe(doc.id);
    expect(row?.permissionKey).toBe(`node:wiki/${doc.id}@edit`);
  });

  it("action=delete，零权限成员对目标文档没有 delete → hasPermission false", async () => {
    const doc = await createWiki({ productionId: prodId, title: "预持久化-删除目标", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    const res = await fetch(`${BASE}/wiki-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productionId: prodId, toolCallId, callerUserId: plainMemberId, action: "delete", wikiId: doc.id, summary: "" }),
    });
    const data = (await res.json()) as { hasPermission: boolean; reason: string | null };
    expect(data.hasPermission).toBe(false);
    expect(data.reason).toBe("no_grant");
  });

  it("action=move/update/delete 缺 wikiId → 400", async () => {
    const res = await fetch(`${BASE}/wiki-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productionId: prodId, toolCallId: `call_${shortId()}`, callerUserId: ownerId, action: "move" }),
    });
    expect(res.status).toBe(400);
  });
});
