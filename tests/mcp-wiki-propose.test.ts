import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { wikiPropose } from "@/lib/mcp/wiki-tools";
import { getWikiProposalByToolCallId, insertWikiProposal } from "@/lib/wiki-proposal-db";

// /wiki-proposal 走真 HTTP（同 tests/mcp-deny-reason.test.ts 的起真服务器套路）——
// MCP_PORT 必须在模块顶层、import server.ts 之前设好。
process.env.MCP_PORT = "3199";
const BASE = "http://127.0.0.1:3199";

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

  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  plainMemberId = (await upsertFeishuUser(`test-open-${shortId()}`, `零权限成员${shortId()}`, null, false)).userId;
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

describe("wikiPropose：真正的安全边界（不信任预持久化的 has_permission）", () => {
  it("有权限（owner）→ 文档真建出来，proposal 行 applied 且 created_wiki_id 对得上", async () => {
    const toolCallId = `call_${shortId()}`;
    const pending = await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: ownerId, parentWikiId: null,
      title: "AI 提议的文档", body: "AI 写的正文", summary: "测试",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });

    const result = await wikiPropose(ownerId, prodId, toolCallId, { title: "AI 提议的文档", body: "AI 写的正文", summary: "测试" });
    expect(result).toContain("已创建文档");

    const updated = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(updated?.status).toBe("applied");
    expect(updated?.createdWikiId).toBeTruthy();
    expect(updated?.id).toBe(pending.id);

    const doc = await getPool().query("SELECT title, created_by FROM wiki WHERE id = $1::uuid", [updated!.createdWikiId]);
    expect(doc.rows[0].title).toBe("AI 提议的文档");
    expect(doc.rows[0].created_by).toBe(ownerId);
  });

  it("无权限（零权限成员）→ 文档没建，proposal 行 blocked_no_permission——即使预持久化时误判 has_permission=true", async () => {
    const toolCallId = `call_${shortId()}`;
    // 刻意造一个"预持久化算错了"的场景，验证工具函数自己重新查权限、不信任这行
    const pending = await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: plainMemberId, parentWikiId: null,
      title: "不该被创建的文档", body: "", summary: "测试",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });

    const result = await wikiPropose(plainMemberId, prodId, toolCallId, { title: "不该被创建的文档", summary: "测试" });
    expect(result).toContain("权限被拒绝");

    const updated = await getWikiProposalByToolCallId(prodId, toolCallId, plainMemberId);
    expect(updated?.status).toBe("blocked_no_permission");
    expect(updated?.id).toBe(pending.id);

    const doc = await getPool().query("SELECT 1 FROM wiki WHERE title = $1 AND production_id = $2", ["不该被创建的文档", prodId]);
    expect(doc.rows.length).toBe(0);
  });

  it("非成员 → 明确拒绝，不建文档", async () => {
    const outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
    const result = await wikiPropose(outsiderId, prodId, `call_${shortId()}`, { title: "局外人建的文档", summary: "测试" });
    expect(result).toContain("权限被拒绝");
    const doc = await getPool().query("SELECT 1 FROM wiki WHERE title = $1", ["局外人建的文档"]);
    expect(doc.rows.length).toBe(0);
  });

  it("归档制作 → 拒绝文案是归档专属，不是引导去申请权限", async () => {
    const { prodId: archivedProd } = await makeProduction(ownerId);
    try {
      await getPool().query("UPDATE production SET archived_at = now() WHERE id = $1", [archivedProd]);
      const result = await wikiPropose(ownerId, archivedProd, `call_${shortId()}`, { title: "归档项目里的文档", summary: "测试" });
      expect(result).toContain("已归档");
      expect(result).not.toContain("权限被拒绝");
    } finally {
      await cleanupProduction(archivedProd).catch(() => {});
    }
  });
});

describe("POST /wiki-proposal 预持久化端点", () => {
  it("有权限的调用者 → hasPermission true，写入一行 pending", async () => {
    const toolCallId = `call_${shortId()}`;
    const res = await fetch(`${BASE}/wiki-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productionId: prodId, toolCallId, callerUserId: ownerId,
        title: "预持久化测试文档", body: "正文", summary: "摘要",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; hasPermission: boolean; reason: string | null };
    expect(data.hasPermission).toBe(true);
    expect(data.reason).toBeNull();

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.status).toBe("pending");
    expect(row?.title).toBe("预持久化测试文档");
  });

  it("零权限成员 → hasPermission false，reason=no_grant", async () => {
    const toolCallId = `call_${shortId()}`;
    const res = await fetch(`${BASE}/wiki-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productionId: prodId, toolCallId, callerUserId: plainMemberId,
        title: "无权限预持久化测试", summary: "摘要",
      }),
    });
    const data = (await res.json()) as { hasPermission: boolean; reason: string | null };
    expect(data.hasPermission).toBe(false);
    expect(data.reason).toBe("no_grant");
  });

  it("缺必填字段 → 400", async () => {
    const res = await fetch(`${BASE}/wiki-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productionId: prodId }),
    });
    expect(res.status).toBe(400);
  });
});
