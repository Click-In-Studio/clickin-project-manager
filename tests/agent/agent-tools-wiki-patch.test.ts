import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/agent/wiki-proposal/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { setNodePublic } from "@/lib/node/db";
import { readFileSync } from "node:fs";
import { applyWikiPatch, lineWindow, textMatches, fuzzyLineMatches } from "@/lib/agent/tools/wiki-text";
import { wikiRead, wikiSearch } from "@/lib/agent/tools/wiki-tools";
import { prepareWikiPatch, wikiProposePatch, type WikiPatchArgs } from "@/lib/agent/tools/wiki-patch-tools";
import { getWikiPatchApproval } from "@/lib/agent/wiki-patch-db";
import { createApproval, resolveApproval } from "@/lib/agent/runtime/approvals";
import { approvalCard } from "@/lib/agent/runtime/cards";
import { buildTools, DEFS, exposedName } from "@/lib/agent/runtime/tools";
import { tieredToolNames } from "@/lib/agent/runtime/tool-tiers";
import { createWiki, getWiki, updateWiki } from "@/lib/wiki/content";
import { getWikiProposalByToolCallId } from "@/lib/wiki/proposal-db";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

// 纯匹配和真 DB 审批一起验证：不得把定位歧义交给模型或模糊兜底。
describe("确定性局部修改", () => {
  const body = "# 排练\n下午两点开始\n备注\n下午两点开始\n";
  it("重复原文默认报错，范围可唯一定位，all 可显式全部替换", () => {
    expect(() => applyWikiPatch(body, [{ oldText: "两点", newText: "三点" }])).toThrow("2 处");
    expect(applyWikiPatch(body, [{ oldText: "两点", newText: "三点", startLine: 4, endLine: 4 }]).body)
      .toBe(body.replace("备注\n下午两点", "备注\n下午三点"));
    expect(applyWikiPatch(body, [{ oldText: "两点", newText: "三点", occurrence: "all", expectedMatches: 2 }]).counts).toEqual([2]);
    expect(() => applyWikiPatch(body, [{ oldText: "两点", newText: "三点", occurrence: "all", expectedMatches: 3 }])).toThrow("expectedMatches");
  });
  it("零命中、重叠、不合法范围和模糊写入均拒绝整批", () => {
    expect(() => applyWikiPatch(body, [{ oldText: "备注", newText: "说明" }, { oldText: "不存在", newText: "内容" }])).toThrow("未匹配");
    expect(() => applyWikiPatch(body, [{ oldText: "备注", newText: "说明" }, { oldText: "注", newText: "意" }])).toThrow("重叠");
    expect(() => lineWindow(body, { startLine: 0 })).toThrow("行范围无效");
    expect(() => lineWindow(body, { startLine: 2, endLine: 99 })).toThrow("行范围无效");
    expect(() => textMatches(body, "两点", "三点", "fuzzy" as "literal")).toThrow("不允许模糊");
  });
  it("所有行范围基于修改前正文，不受前项增删行影响；可删除与插入", () => {
    expect(applyWikiPatch(body, [
      { oldText: "# 排练", newText: "# 排练\n新增说明" },
      { oldText: "下午两点开始", newText: "", startLine: 4, endLine: 4 },
    ]).body).toBe("# 排练\n新增说明\n下午两点开始\n备注\n\n");
  });
  it("正则支持多行、捕获组、命名捕获、大小写选项，字面量不展开美元符", () => {
    expect(applyWikiPatch("A:12\na:34", [{ oldText: "^a:(\\d+)$", newText: "$1元$$$&", matchMode: "regex", flags: "im", occurrence: "all" }]).body).toBe("12元$A:12\n34元$a:34");
    expect(applyWikiPatch("日期2026", [{ oldText: "日期(?<year>\\d+)", newText: "$<year>年", matchMode: "regex" }]).body).toBe("2026年");
    expect(applyWikiPatch("abc", [{ oldText: "abc", newText: "$1$&" }]).body).toBe("$1$&");
    expect(applyWikiPatch("甲\n乙", [{ oldText: "甲.*乙", newText: "丙", matchMode: "regex", flags: "s" }]).body).toBe("丙");
  });
  it("正则非法、零长度与灾难性回溯及时失败", () => {
    expect(() => textMatches("abc", "[", "", "regex")).toThrow("正则匹配失败");
    expect(() => textMatches("abc", "^", "", "regex")).toThrow("零长度");
    expect(() => textMatches("abc", "a", "", "regex", "ii")).toThrow("flags");
    expect(() => textMatches("a".repeat(50000) + "!", "(a+)+$", "", "regex")).toThrow("超时");
  });
  it("模糊搜索返回候选，不改变待修改原文", () => {
    expect(fuzzyLineMatches("排练时间改为下午三点\n预算暂定", "排练时间为下午三点")[0].index).toBe(0);
  });
  it("注册、审批预检、写审计和召回闭包接线齐全", () => {
    const def = DEFS.find(d => d.mcpName === "production.wiki_propose_patch")!;
    expect(def.readOnly).toBe(false);
    expect(def.mutates?.({ wikiId: "w" })).toMatchObject({ scope: "wiki", action: "updated", ids: ["w"] });
    expect(def.unattended).toBe("deny");
    expect(readFileSync("lib/agent/runtime/service.ts", "utf8")).toContain('bare === "production-wiki_propose_patch"');
    const tier = tieredToolNames({ hasProduction: true, pageKey: "prod:home", prompt: null, recalled: [def.mcpName], available: DEFS.map(d => d.mcpName) });
    expect(tier.active).toEqual(expect.arrayContaining(["production.wiki_read", "production.wiki_search", "production.wiki_dialect_ref"]));
  });
});

let prodId: string;
let ownerId: string;
let memberId: string;
let outsiderId: string;
let sessionId: string;
let runId: string;
const extraSessions: string[] = [];
beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, "局部修改所有者", null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, "局部修改成员", null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, "局部修改非成员", null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, memberId);
  sessionId = `as_${shortId()}`;
  runId = `ar_${shortId()}`;
  await getPool().query("INSERT INTO agent_session (id,user_id,production_id) VALUES ($1,$2,$3)", [sessionId, ownerId, prodId]);
  await getPool().query("INSERT INTO agent_run (id,session_id) VALUES ($1,$2)", [runId, sessionId]);
});
afterAll(async () => {
  await getPool().query("DELETE FROM agent_session WHERE id=$1", [sessionId]).catch(() => {});
  for (const id of extraSessions) await getPool().query("DELETE FROM agent_session WHERE id=$1", [id]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

async function approved(args: WikiPatchArgs) {
  const toolCallId = `patch_${shortId()}`;
  const prepared = await prepareWikiPatch(ownerId, prodId, toolCallId, args);
  expect(prepared.error).toBeUndefined();
  const { id } = await createApproval({ runId, sessionId, toolCallId, tool: exposedName("production.wiki_propose_patch"), args,
    card: approvalCard("production-wiki_propose_patch", args), preview: prepared.preview });
  await resolveApproval(id, "allow-once", ownerId);
  return toolCallId;
}

describe("局部读写真链路", () => {
  it("长文档只传局部修改，确认后真工具落库、历史和审计完整，结果不带全文", async () => {
    const body = Array.from({ length: 6000 }, (_, i) => `第${i + 1}条：排练安排待定。`).join("\n");
    const doc = await createWiki({ productionId: prodId, title: "长排练记录", body, createdBy: ownerId });
    const args: WikiPatchArgs = { wikiId: doc.id, edits: [{ oldText: "排练安排待定", newText: "下午三点排练", startLine: 3000, endLine: 3000 }], summary: "确定时间" };
    const callId = await approved(args);
    const tool = buildTools({ userId: ownerId, productionId: prodId, run: { runId, sessionId, signal: new AbortController().signal, publish: () => {}, setStatus: async () => {}, isDetached: () => false } }).find(t => t.mcpName === "production.wiki_propose_patch")!;
    const result = await tool.execute(callId, args);
    expect(JSON.stringify(result).length).toBeLessThan(500);
    expect((await getWiki(doc.id, prodId))?.body).toBe(body.replace("第3000条：排练安排待定", "第3000条：下午三点排练"));
    expect((await getWikiProposalByToolCallId(prodId, callId, ownerId))?.status).toBe("applied");
    expect((await getPool().query("SELECT body FROM wiki_revision WHERE wiki_id=$1 AND origin='ai-proposed'", [doc.id])).rows).toHaveLength(1);
    expect((await getPool().query("SELECT id FROM agent_mutation WHERE tool_call_id=$1", [callId])).rows).toHaveLength(1);
    expect(await wikiProposePatch(ownerId, prodId, callId, args)).toContain("未重复修改");
    expect((await prepareWikiPatch(ownerId, prodId, callId, args)).error).toContain("已经处理");
  });
  it("搜索返回准确行号、限量与上下文；范围读取不混入行号，保留引用原文", async () => {
    const body = "# 排练\n## 时间\n下午两点\n备注\n下午两点\n[#](/__cm__/wiki/00000000-0000-4000-8000-000000000099)";
    const doc = await createWiki({ productionId: prodId, title: "定位文档", body, createdBy: ownerId });
    const search = JSON.parse(await wikiSearch(ownerId, prodId, "下午两点", { wikiId: doc.id, limit: 1 }));
    expect(search).toMatchObject({ totalMatches: 2, truncated: true, matches: [{ startLine: 3, endLine: 3 }] });
    const regex = JSON.parse(await wikiSearch(ownerId, prodId, "下午.*", { wikiId: doc.id, matchMode: "regex", startLine: 5, endLine: 5 }));
    expect(regex.matches[0].startLine).toBe(5);
    const read = await wikiRead(ownerId, prodId, doc.id, { startLine: 3, endLine: 6 });
    const [meta, content] = [JSON.parse(read.slice(0, read.indexOf("\n\n"))), read.slice(read.indexOf("\n\n") + 2)];
    expect(meta).toMatchObject({ partial: true, totalLines: 6, sectionPath: ["排练", "时间"] });
    expect(content).toBe(body.split("\n").slice(2).join("\n"));
    expect(await wikiRead(ownerId, prodId, doc.id, { startLine: 99 })).toContain("行范围无效");
  });
  it("确认详情展示服务端真实差异，其他用户不能读取；库搜索工具仍可直接使用", async () => {
    const doc = await createWiki({ productionId: prodId, title: `搜索目标${shortId()}`, body: "原文\n保留", createdBy: ownerId });
    const callId = await approved({ wikiId: doc.id, edits: [{ oldText: "原文", newText: "新文" }], summary: "局部修改" });
    const request = (userId: string) => new NextRequest(`http://localhost/api/agent/wiki-proposal?productionId=${prodId}&toolCallId=${callId}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}` },
    });
    const response = await GET(request(ownerId));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.patchCounts).toEqual([1]);
    expect(data.patchDiff).toContain("-原文");
    expect(data.patchDiff).toContain("+新文");
    expect((await GET(request(memberId))).status).toBe(404);
    const tool = buildTools({ userId: ownerId, productionId: prodId }).find(t => t.mcpName === "production.wiki_search")!;
    expect(JSON.stringify(await tool.execute(shortId(), { query: doc.title }))).toContain(doc.title);
  });
  it("patch 复用方言真门，非法引用不落提议也不改正文", async () => {
    const doc = await createWiki({ productionId: prodId, title: "方言门", body: "原文", createdBy: ownerId });
    const callId = `patch_${shortId()}`;
    const prepared = await prepareWikiPatch(ownerId, prodId, callId, {
      wikiId: doc.id, edits: [{ oldText: "原文", newText: "[[不存在的引用目标]]" }], summary: "非法引用",
    });
    expect(prepared.error).toContain("方言校验拒绝");
    expect(await getWikiProposalByToolCallId(prodId, callId, ownerId)).toBeNull();
    expect((await getWiki(doc.id, prodId))?.body).toBe("原文");
  });
  it("收回查看权限后，服务端拼出的整篇提议与差异不再从详情泄露", async () => {
    const doc = await createWiki({ productionId: prodId, title: "临时公开", body: "秘密原文", createdBy: ownerId });
    await setNodePublic(doc.nodeId, prodId, true);
    const callId = `patch_${shortId()}`;
    const args: WikiPatchArgs = { wikiId: doc.id, edits: [{ oldText: "原文", newText: "新文" }], summary: "修改" };
    const prepared = await prepareWikiPatch(memberId, prodId, callId, args);
    await setNodePublic(doc.nodeId, prodId, false);
    const cookie = `${SESSION_COOKIE}=${createSession({ userId: memberId, name: "测试", avatarUrl: null, isAdmin: false })}`;
    const request = () => new NextRequest(`http://localhost/api/agent/wiki-proposal?productionId=${prodId}&toolCallId=${callId}`, { headers: { Cookie: cookie } });
    // 预持久化和审批建行之间，同样不能通过 update.body 回读服务端拼出的全文。
    expect(await (await GET(request())).json()).toMatchObject({ body: "", patchDiff: null, targetBody: null });
    const memberSession = `as_${shortId()}`;
    extraSessions.push(memberSession);
    const memberRun = `ar_${shortId()}`;
    await getPool().query("INSERT INTO agent_session (id,user_id,production_id) VALUES ($1,$2,$3)", [memberSession, memberId, prodId]);
    await getPool().query("INSERT INTO agent_run (id,session_id) VALUES ($1,$2)", [memberRun, memberSession]);
    await createApproval({ runId: memberRun, sessionId: memberSession, toolCallId: callId,
      tool: exposedName("production.wiki_propose_patch"), args, card: approvalCard("production-wiki_propose_patch", args), preview: prepared.preview });
    const response = await GET(request());
    expect(await response.json()).toMatchObject({ body: "", patchDiff: null, patchCounts: null, targetBody: null });
  });
  it("公开可读并不授予编辑权限，预览和执行均按编辑门判定", async () => {
    const doc = await createWiki({ productionId: prodId, title: "公开", body: "原文", createdBy: ownerId });
    await setNodePublic(doc.nodeId, prodId, true);
    const args: WikiPatchArgs = { wikiId: doc.id, edits: [{ oldText: "原文", newText: "新文" }], summary: "修改" };
    expect((await prepareWikiPatch(memberId, prodId, shortId(), args)).hasPermission).toBe(false);
    expect(await wikiProposePatch(memberId, prodId, shortId(), args)).toContain("权限被拒绝");
    expect((await getWiki(doc.id, prodId))?.body).toBe("原文");
  });
  it("审批后变化拒绝；恢复预检复用原快照，不重新规划旧确认卡", async () => {
    const doc = await createWiki({ productionId: prodId, title: "并发", body: "原始正文", createdBy: ownerId });
    const args: WikiPatchArgs = { wikiId: doc.id, edits: [{ oldText: "原始", newText: "修改" }], summary: "改正文" };
    const callId = await approved(args);
    const before = await getWikiPatchApproval(ownerId, prodId, callId);
    await updateWiki(doc.id, prodId, { body: "人工修改后的正文" }, ownerId);
    const recovered = await prepareWikiPatch(ownerId, prodId, callId, args);
    expect(recovered.preview).toEqual(before?.preview);
    expect(await wikiProposePatch(ownerId, prodId, callId, args)).toContain("已发生变化");
    expect((await getWiki(doc.id, prodId))?.body).toBe("人工修改后的正文");
    await expect(updateWiki(doc.id, prodId, { body: "覆盖", expectedBody: "原始正文" }, ownerId)).rejects.toThrow("WIKI_BODY_CHANGED");
  });
  it("没有确认不能写；非成员、不可见和无编辑权限不能改", async () => {
    const doc = await createWiki({ productionId: prodId, title: "私有", body: "原文", createdBy: ownerId });
    const args: WikiPatchArgs = { wikiId: doc.id, edits: [{ oldText: "原文", newText: "新文" }], summary: "修改" };
    expect((await prepareWikiPatch(outsiderId, prodId, shortId(), args)).error).toContain("权限被拒绝");
    expect((await prepareWikiPatch(memberId, prodId, shortId(), args)).error).toContain("权限被拒绝");
    expect(await wikiSearch(memberId, prodId, "原文", { wikiId: doc.id })).toContain("权限被拒绝");
    expect(await wikiProposePatch(ownerId, prodId, shortId(), args)).toContain("没有找到已确认");
    expect((await getWiki(doc.id, prodId))?.body).toBe("原文");
  });
});

it("Wiki 超长单行可以从搜索位置窗口读回，默认预览明确标记省略", async () => {
  const doc = await createWiki({ productionId: prodId, title: "长行定位", body: "# 标题\n" + "甲".repeat(20000) + "行尾证据", createdBy: ownerId });
  const preview = await wikiRead(ownerId, prodId, doc.id);
  expect(preview).not.toContain("行尾证据");
  expect(JSON.parse(preview.split("\n")[0]).partial).toBe(true);
  const search = JSON.parse(await wikiSearch(ownerId, prodId, "行尾证据", { wikiId: doc.id }));
  const match = search.matches[0];
  expect(match.offsetInStartLine).toBe(20000);
  const body = await wikiRead(ownerId, prodId, doc.id, { startLine: match.startLine, endLine: match.endLine, window: { offset: match.offsetInStartLine } });
  expect(body).toContain("行尾证据");
  expect(await wikiRead(outsiderId, prodId, doc.id, { window: { offset: 20000 } })).toContain("权限被拒绝");
});
