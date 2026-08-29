import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createEventReport } from "@/lib/event-db";
import { getPool } from "@/lib/pg";
import { createWiki, getWiki } from "@/lib/wiki-db";
import { wikiProposeUpdate, wikiProposeDelete, wikiProposeMove, wikiProposeTag } from "@/lib/agent-tools/wiki-tools";
import { getWikiProposalByToolCallId, insertWikiProposal, type WikiProposalAction } from "@/lib/wiki-proposal-db";
import { prepareWikiProposal } from "@/lib/agent-tools/wiki-proposal-prepare";
import { DENIED_NOT_MEMBER } from "@/lib/agent-tools/production-tools";

// update/delete/move/tag 四个动作各自的门是实例级（canEditWiki/canDeleteWiki 对
// 具体这一篇文档），不是 create 那种域级门——所以每个用例都要真造一个"对
// 这篇文档没有 edit/delete 权限"的成员，不能只靠零权限成员一概而论。
//
// 真实链路里插件永远先预持久化一行 wiki_proposal 再调工具函数——之前的
// 用例漏了这一步（没造 proposal 行），markWikiProposalApplied 那句
// if (proposal) 直接被短路跳过，delete 场景硬把已删除的 wikiId 写回
// created_wiki_id 违反外键约束这个真实 bug 因此没被测出来（用户线上撞到
// 的）。现在统一用 preInsertProposal 补上这一步，让测试真的跑到写 DB 那行。
let prodId: string;
let ownerId: string;
let plainMemberId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `动作测试所有者${shortId()}`, null, false)).userId;
  plainMemberId = (await upsertFeishuUser(`test-open-${shortId()}`, `动作测试零权限成员${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, plainMemberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

/** 模拟插件 before_tool_call 的预持久化步骤——真实链路里这一步永远先跑，
 *  工具函数才会真的执行 markWikiProposalApplied/Blocked 那几行 DB 写入。 */
async function preInsertProposal(opts: {
  toolCallId: string; proposedBy: string; action: WikiProposalAction; wikiId?: string;
}) {
  return insertWikiProposal({
    productionId: prodId, toolCallId: opts.toolCallId, proposedBy: opts.proposedBy,
    action: opts.action, targetWikiId: opts.action === "create" ? null : (opts.wikiId ?? null),
    title: "占位", summary: "", hasPermission: true, permissionKey: "node:wiki/*@create",
  });
}

describe("wikiProposeUpdate", () => {
  it("owner（对这篇文档有 edit 权限）→ 真更新，proposal applied 且 created_wiki_id=doc.id", async () => {
    const doc = await createWiki({ productionId: prodId, title: "旧标题", body: "旧正文", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    await preInsertProposal({ toolCallId, proposedBy: ownerId, action: "update", wikiId: doc.id });

    const result = await wikiProposeUpdate(ownerId, prodId, toolCallId, { wikiId: doc.id, title: "新标题", body: "新正文", summary: "测试" });
    expect(result).toContain("已更新文档");
    const updated = await getWiki(doc.id, prodId);
    expect(updated?.title).toBe("新标题");
    expect(updated?.body).toBe("新正文");

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.status).toBe("applied");
    expect(row?.createdWikiId).toBe(doc.id);
  });

  it("对这篇文档没有 edit 权限的成员（非创建者、非 owner）→ 拦截，内容不变，proposal blocked_no_permission", async () => {
    const doc = await createWiki({ productionId: prodId, title: "受保护标题", body: "受保护正文", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    await preInsertProposal({ toolCallId, proposedBy: plainMemberId, action: "update", wikiId: doc.id });

    const result = await wikiProposeUpdate(plainMemberId, prodId, toolCallId, { wikiId: doc.id, title: "篡改标题", summary: "测试" });
    expect(result).toContain("权限被拒绝");
    const unchanged = await getWiki(doc.id, prodId);
    expect(unchanged?.title).toBe("受保护标题");

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, plainMemberId);
    expect(row?.status).toBe("blocked_no_permission");
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
  it("owner 删除普通文档 → 真删除，proposal applied 且 created_wiki_id 是 null（文档已不存在，FK 指不了）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "待删文档", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    await preInsertProposal({ toolCallId, proposedBy: ownerId, action: "delete", wikiId: doc.id });

    // 回归锁定：这一步之前会因为把已删除的 wikiId 写回 created_wiki_id
    // 违反外键约束而抛错（用户线上实测撞到），不应该抛。
    await expect(wikiProposeDelete(ownerId, prodId, toolCallId, { wikiId: doc.id, summary: "清理" })).resolves.toContain("已删除");
    expect(await getWiki(doc.id, prodId)).toBeNull();

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.status).toBe("applied");
    expect(row?.createdWikiId).toBeNull();
  });

  it("对这篇文档没有 delete 权限的成员 → 拦截，文档还在，proposal blocked_no_permission", async () => {
    const doc = await createWiki({ productionId: prodId, title: "受保护待删文档", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    await preInsertProposal({ toolCallId, proposedBy: plainMemberId, action: "delete", wikiId: doc.id });

    const result = await wikiProposeDelete(plainMemberId, prodId, toolCallId, { wikiId: doc.id, summary: "测试" });
    expect(result).toContain("权限被拒绝");
    expect(await getWiki(doc.id, prodId)).not.toBeNull();

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, plainMemberId);
    expect(row?.status).toBe("blocked_no_permission");
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
    await preInsertProposal({ toolCallId, proposedBy: ownerId, action: "delete", wikiId: mountedWikiId });

    const result = await wikiProposeDelete(ownerId, prodId, toolCallId, { wikiId: mountedWikiId, summary: "测试" });
    expect(result).toContain("被挂载");
    expect(result).not.toContain("权限被拒绝");
    expect(await getWiki(mountedWikiId, prodId)).not.toBeNull();

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.status).toBe("blocked_business_rule");
  });
});

describe("wikiProposeMove", () => {
  it("owner 移动到新父 → parent_id 真的变了，proposal applied 且 created_wiki_id=doc.id", async () => {
    const oldParent = await createWiki({ productionId: prodId, title: "旧父", createdBy: ownerId });
    const newParent = await createWiki({ productionId: prodId, title: "新父", createdBy: ownerId });
    const doc = await createWiki({ productionId: prodId, title: "被移动的文档", parentId: oldParent.id, createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    await preInsertProposal({ toolCallId, proposedBy: ownerId, action: "move", wikiId: doc.id });

    const result = await wikiProposeMove(ownerId, prodId, toolCallId, { wikiId: doc.id, newParentId: newParent.id, summary: "重新归档" });
    expect(result).toContain("已把文档");
    expect((await getWiki(doc.id, prodId))?.parentId).toBe(newParent.id);

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.status).toBe("applied");
    expect(row?.createdWikiId).toBe(doc.id);
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
    await preInsertProposal({ toolCallId, proposedBy: ownerId, action: "move", wikiId: a.id });

    const result = await wikiProposeMove(ownerId, prodId, toolCallId, { wikiId: a.id, newParentId: b.id, summary: "" });
    expect(result).not.toContain("已把文档");
    expect((await getWiki(a.id, prodId))?.parentId).toBeNull(); // 没被改动

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.status).toBe("blocked_business_rule");
  });

  it("对这篇文档没有 edit 权限的成员 → 拦截，位置不变", async () => {
    const doc = await createWiki({ productionId: prodId, title: "受保护位置文档", createdBy: ownerId });
    const target = await createWiki({ productionId: prodId, title: "目标父", createdBy: ownerId });
    const result = await wikiProposeMove(plainMemberId, prodId, `call_${shortId()}`, { wikiId: doc.id, newParentId: target.id, summary: "" });
    expect(result).toContain("权限被拒绝");
    expect((await getWiki(doc.id, prodId))?.parentId).toBeNull();
  });
});

describe("wikiProposeTag", () => {
  it("owner 设置标签（整体替换）→ 真替换，proposal applied 且 created_wiki_id=doc.id", async () => {
    const doc = await createWiki({ productionId: prodId, title: "待打标签文档", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    await preInsertProposal({ toolCallId, proposedBy: ownerId, action: "tag", wikiId: doc.id });

    const result = await wikiProposeTag(ownerId, prodId, toolCallId, { wikiId: doc.id, tags: ["剧本", "重要"], summary: "分类" });
    expect(result).toContain("剧本");
    expect(result).toContain("重要");
    const updated = await getWiki(doc.id, prodId);
    expect(updated?.tags?.sort()).toEqual(["剧本", "重要"]);

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.status).toBe("applied");
    expect(row?.createdWikiId).toBe(doc.id);
  });

  it("再次设置为空数组 → 整体替换清空，不是增量保留旧标签", async () => {
    const doc = await createWiki({ productionId: prodId, title: "待清空标签文档", createdBy: ownerId });
    await wikiProposeTag(ownerId, prodId, `call_${shortId()}`, { wikiId: doc.id, tags: ["旧标签"], summary: "" });
    expect((await getWiki(doc.id, prodId))?.tags).toEqual(["旧标签"]);

    const result = await wikiProposeTag(ownerId, prodId, `call_${shortId()}`, { wikiId: doc.id, tags: [], summary: "" });
    expect(result).toContain("已清空");
    expect((await getWiki(doc.id, prodId))?.tags).toEqual([]);
  });

  it("对这篇文档没有 edit 权限的成员 → 拦截，标签不变，proposal blocked_no_permission", async () => {
    const doc = await createWiki({ productionId: prodId, title: "受保护标签文档", body: "", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    await preInsertProposal({ toolCallId, proposedBy: plainMemberId, action: "tag", wikiId: doc.id });

    const result = await wikiProposeTag(plainMemberId, prodId, toolCallId, { wikiId: doc.id, tags: ["篡改"], summary: "" });
    expect(result).toContain("权限被拒绝");
    expect((await getWiki(doc.id, prodId))?.tags).toEqual([]);

    const row = await getWikiProposalByToolCallId(prodId, toolCallId, plainMemberId);
    expect(row?.status).toBe("blocked_no_permission");
  });

  it("非成员 → 明确拒绝", async () => {
    const doc = await createWiki({ productionId: prodId, title: "T2", createdBy: ownerId });
    const outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `动作测试局外人2${shortId()}`, null, false)).userId;
    expect(await wikiProposeTag(outsiderId, prodId, `call_${shortId()}`, { wikiId: doc.id, tags: ["x"], summary: "" })).toBe(DENIED_NOT_MEMBER);
  });
});

describe("prepareWikiProposal：action=update/delete/move/tag 用实例级权限判定（原 /wiki-proposal 端点）", () => {
  it("action=update，owner 对目标文档有 edit → hasPermission true，permissionKey 带具体 wikiId", async () => {
    const doc = await createWiki({ productionId: prodId, title: "预持久化-更新目标", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    const r = await prepareWikiProposal({ productionId: prodId, toolCallId, callerUserId: ownerId, action: "update", wikiId: doc.id, title: "新标题", summary: "" });
    expect(r.ok && r.hasPermission).toBe(true);
    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.action).toBe("update");
    expect(row?.targetWikiId).toBe(doc.id);
    expect(row?.permissionKey).toBe(`node:wiki/${doc.id}@edit`);
  });

  it("action=delete，零权限成员对目标文档没有 delete → hasPermission false", async () => {
    const doc = await createWiki({ productionId: prodId, title: "预持久化-删除目标", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    const r = await prepareWikiProposal({ productionId: prodId, toolCallId, callerUserId: plainMemberId, action: "delete", wikiId: doc.id, summary: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hasPermission).toBe(false);
    expect(r.reason).toBe("no_grant");
  });

  it("action=tag，owner 对目标文档有 edit → hasPermission true，tags 落地进 proposal 行", async () => {
    const doc = await createWiki({ productionId: prodId, title: "预持久化-标签目标", createdBy: ownerId });
    const toolCallId = `call_${shortId()}`;
    const r = await prepareWikiProposal({ productionId: prodId, toolCallId, callerUserId: ownerId, action: "tag", wikiId: doc.id, tags: ["a", "b"], summary: "" });
    expect(r.ok && r.hasPermission).toBe(true);
    const row = await getWikiProposalByToolCallId(prodId, toolCallId, ownerId);
    expect(row?.action).toBe("tag");
    expect(row?.tags).toEqual(["a", "b"]);
    expect(row?.permissionKey).toBe(`node:wiki/${doc.id}@edit`);
  });
});
