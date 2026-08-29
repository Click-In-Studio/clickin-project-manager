import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { wikiProposeCreate } from "@/lib/agent-tools/wiki-tools";
import { prepareWikiProposal } from "@/lib/agent-tools/wiki-proposal-prepare";
import { getWikiProposalByToolCallId, insertWikiProposal } from "@/lib/wiki-proposal-db";

let prodId: string;
let ownerId: string;
let plainMemberId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  plainMemberId = (await upsertFeishuUser(`test-open-${shortId()}`, `零权限成员${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, plainMemberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("wikiPropose：真正的安全边界（不信任预持久化的 has_permission）", () => {
  it("有权限（owner）→ 文档真建出来，proposal 行 applied 且 created_wiki_id 对得上", async () => {
    const toolCallId = `call_${shortId()}`;
    const pending = await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: ownerId, action: "create", parentWikiId: null,
      title: "AI 提议的文档", body: "AI 写的正文", summary: "测试",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });

    const result = await wikiProposeCreate(ownerId, prodId, toolCallId, { title: "AI 提议的文档", body: "AI 写的正文", summary: "测试" });
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
      productionId: prodId, toolCallId, proposedBy: plainMemberId, action: "create", parentWikiId: null,
      title: "不该被创建的文档", body: "", summary: "测试",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });

    const result = await wikiProposeCreate(plainMemberId, prodId, toolCallId, { title: "不该被创建的文档", summary: "测试" });
    expect(result).toContain("权限被拒绝");

    const updated = await getWikiProposalByToolCallId(prodId, toolCallId, plainMemberId);
    expect(updated?.status).toBe("blocked_no_permission");
    expect(updated?.id).toBe(pending.id);

    const doc = await getPool().query("SELECT 1 FROM wiki WHERE title = $1 AND production_id = $2", ["不该被创建的文档", prodId]);
    expect(doc.rows.length).toBe(0);
  });

  it("非成员 → 明确拒绝，不建文档", async () => {
    const outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
    const result = await wikiProposeCreate(outsiderId, prodId, `call_${shortId()}`, { title: "局外人建的文档", summary: "测试" });
    expect(result).toContain("权限被拒绝");
    const doc = await getPool().query("SELECT 1 FROM wiki WHERE title = $1", ["局外人建的文档"]);
    expect(doc.rows.length).toBe(0);
  });

  it("归档制作 → 拒绝文案是归档专属，不是引导去申请权限", async () => {
    const { prodId: archivedProd } = await makeProduction(ownerId);
    try {
      await getPool().query("UPDATE production SET archived_at = now() WHERE id = $1", [archivedProd]);
      const result = await wikiProposeCreate(ownerId, archivedProd, `call_${shortId()}`, { title: "归档项目里的文档", summary: "测试" });
      expect(result).toContain("已归档");
      expect(result).not.toContain("权限被拒绝");
    } finally {
      await cleanupProduction(archivedProd).catch(() => {});
    }
  });
});

describe("prepareWikiProposal 预持久化（原 /wiki-proposal 端点，MCP 退役后直接调）", () => {
  it("有权限的调用者 → hasPermission true，写入一行 pending", async () => {
    const toolCallId = `call_${shortId()}`;
    const r = await prepareWikiProposal({
      productionId: prodId, toolCallId, callerUserId: ownerId, action: "create",
      title: "预持久化测试文档", body: "正文", summary: "摘要",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hasPermission).toBe(true);
    expect(r.reason).toBeNull();
    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.status).toBe("pending");
    expect(row?.title).toBe("预持久化测试文档");
  });

  it("零权限成员 → hasPermission false，reason=no_grant", async () => {
    const toolCallId = `call_${shortId()}`;
    const r = await prepareWikiProposal({
      productionId: prodId, toolCallId, callerUserId: plainMemberId, action: "create",
      title: "无权限预持久化测试", summary: "摘要",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hasPermission).toBe(false);
    expect(r.reason).toBe("no_grant");
  });
});

describe("insertWikiProposal 幂等（AI review #249：网关重试/重放同一 toolCallId 不该堆孤儿行）", () => {
  it("同一 toolCallId 重复插入且仍 pending → 回填同一行，不是两行", async () => {
    const toolCallId = `call_${shortId()}`;
    const first = await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: ownerId, action: "create", parentWikiId: null,
      title: "第一次预持久化", body: "", summary: "",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });
    const second = await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: ownerId, action: "create", parentWikiId: null,
      title: "第二次预持久化（内容更新）", body: "", summary: "",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });
    expect(second.id).toBe(first.id); // 同一行，不是新行
    expect(second.title).toBe("第二次预持久化（内容更新）"); // pending 时内容可刷新

    const count = await getPool().query(
      "SELECT count(*)::int AS n FROM wiki_proposal WHERE production_id = $1 AND tool_call_id = $2",
      [prodId, toolCallId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("已 resolve（applied）的行不会被重放的预持久化覆盖", async () => {
    const toolCallId = `call_${shortId()}`;
    const pending = await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: ownerId, action: "create", parentWikiId: null,
      title: "将被应用的提议", body: "", summary: "",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });
    await wikiProposeCreate(ownerId, prodId, toolCallId, { title: "将被应用的提议", summary: "" });

    const replay = await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: ownerId, action: "create", parentWikiId: null,
      title: "重放不该生效的标题", body: "", summary: "",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });
    expect(replay.id).toBe(pending.id);
    expect(replay.status).toBe("applied"); // 没被打回 pending
    expect(replay.title).toBe("将被应用的提议"); // 内容没被重放覆盖
  });
});
