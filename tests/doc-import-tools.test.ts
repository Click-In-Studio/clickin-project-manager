// #47 导入指示 skill + 导入日志测试。
// 重点钉三件事：①自写域边界——append 只认首个 revision origin 钉死的日志
// 文档，普通 wiki 冒充不进免卡通道；②selfScribe 旁路不扩散——全注册表里
// 只允许 doc_import_log_append 一个（新工具想开必须来改这条测试=显式决策）；
// ③guide 是升级协议不是案例大全——关键纪律词都在。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";
import { createWiki } from "@/lib/wiki/content";
import {
  DOC_IMPORT_GUIDE, IMPORT_LOG_ORIGIN,
  docImportLogCreate, docImportLogAppend,
} from "@/lib/agent-tools/doc-import-tools";
import { DEFS, buildTools } from "@/lib/agent-runtime/tools";
import { updateWiki } from "@/lib/wiki/content";
import { getPool } from "@/lib/pg";

let prodId: string;
let ownerId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `导入owner-${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

async function firstRevisionOrigin(wikiId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ origin: string }>(
    `SELECT origin FROM wiki_revision WHERE wiki_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
    [wikiId],
  );
  return rows[0]?.origin ?? null;
}

function extractWikiId(out: string): string {
  const m = out.match(/wikiId: ([\w-]+)/);
  expect(m, `输出里应含 wikiId：${out}`).toBeTruthy();
  return m![1];
}

describe("导入日志：自写域边界", () => {
  it("create 落 origin 标记 + append 成功追加", async () => {
    const out = await docImportLogCreate(ownerId, prodId, { title: `导入日志-${shortId()}`, body: "## 判例集\n" });
    const wikiId = extractWikiId(out);
    expect(await firstRevisionOrigin(wikiId)).toBe(IMPORT_LOG_ORIGIN);

    const r1 = await docImportLogAppend(ownerId, prodId, { wikiId, text: "判例1：括号注释进 annotation" });
    expect(r1).toContain("已追加");
    const r2 = await docImportLogAppend(ownerId, prodId, { wikiId, text: "游标：已处理到 ¶120" });
    expect(r2).toContain("已追加");

    const { rows } = await getPool().query<{ body: string }>(`SELECT body FROM wiki WHERE id = $1`, [wikiId]);
    expect(rows[0].body).toContain("判例1");
    expect(rows[0].body).toContain("¶120");
    expect(rows[0].body.indexOf("判例1")).toBeLessThan(rows[0].body.indexOf("¶120")); // 追加序
  });

  it("普通 wiki 文档冒充不进免卡通道（首 revision origin 不符即拒）", async () => {
    const normal = await createWiki({ productionId: prodId, title: `普通文档-${shortId()}`, body: "正文", createdBy: ownerId });
    const out = await docImportLogAppend(ownerId, prodId, { wikiId: normal.id, text: "试图混入" });
    expect(out).toContain("不是导入日志");
    const { rows } = await getPool().query<{ body: string }>(`SELECT body FROM wiki WHERE id = $1`, [normal.id]);
    expect(rows[0].body).toBe("正文"); // 未被写入
  });

  it("后期 revision 带 log origin 也冒充不了（标记只认**首个** revision）", async () => {
    // AI review 适配：对抗面——普通文档先正常改一版，再用 log origin 改一版，
    // 首 revision 仍是 "user" ⇒ 必须拒。判据是创建时刻钉死的，后天洗不白。
    const normal = await createWiki({ productionId: prodId, title: `洗白尝试-${shortId()}`, body: "v1", createdBy: ownerId });
    await updateWiki(normal.id, prodId, { body: "v2", mergeBase: "v1", origin: IMPORT_LOG_ORIGIN }, ownerId);
    const out = await docImportLogAppend(ownerId, prodId, { wikiId: normal.id, text: "洗白后混入" });
    expect(out).toContain("不是导入日志");
  });

  it("selfScribe 经 buildTools 执行仍落 agent_mutation 审计行（审计独立于审批门）", async () => {
    // AI review 适配：钉死「免卡≠免审计」——审计包在 buildTools 的 execute
    // 包装层，与 approvalGate 正交；这条测试守住该不变量（谁把审计挪进
    // 审批门内，这里会红）。
    const created = await docImportLogCreate(ownerId, prodId, { title: `审计验证-${shortId()}` });
    const wikiId = extractWikiId(created);
    const tools = buildTools({ userId: ownerId, productionId: prodId });
    const appendTool = tools.find((t) => t.mcpName === "production.doc_import_log_append")!;
    expect(appendTool.selfScribe).toBe(true);
    const toolCallId = `test-scribe-${shortId()}`;
    const result = await appendTool.execute(toolCallId, { wikiId, text: "经完整包装层写入" });
    expect(JSON.stringify(result.content)).toContain("已追加");
    const { rows } = await getPool().query(
      `SELECT scope, action, unattended FROM agent_mutation WHERE tool_call_id = $1 AND tool = 'production.doc_import_log_append'`,
      [toolCallId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ scope: "wiki", action: "updated", unattended: false });
  });

  it("非成员拒绝；超长追加拒绝", async () => {
    const out = await docImportLogCreate(ownerId, prodId, { title: `边界-${shortId()}` });
    const wikiId = extractWikiId(out);
    const stranger = (await upsertFeishuUser(`test-open-${shortId()}`, `路人-${shortId()}`, null, false)).userId;
    expect(await docImportLogAppend(stranger, prodId, { wikiId, text: "x" })).toContain("权限");
    expect(await docImportLogAppend(ownerId, prodId, { wikiId, text: "长".repeat(9000) })).toContain("过长");
  });
});

describe("selfScribe 旁路不扩散", () => {
  it("全注册表里只有 doc_import_log_append 一个自写域工具（新增须显式改这条测试）", () => {
    const scribes = DEFS.filter((d) => d.selfScribe).map((d) => d.mcpName);
    expect(scribes).toEqual(["production.doc_import_log_append"]);
  });

  it("自写域工具必须申报 mutates（审计不可减免）且非只读", () => {
    for (const d of DEFS.filter((d) => d.selfScribe)) {
      expect(d.readOnly, d.mcpName).toBe(false);
      expect(typeof d.mutates, d.mcpName).toBe("function");
    }
  });
});

describe("全树与误用反馈（2026-09-07 定谳：AI 树=用户视角、用错工具明确指路）", () => {
  let assetId: string;
  let wikiId: string;

  beforeAll(async () => {
    const { createAsset } = await import("@/lib/asset/db");
    const created = await createAsset({
      productionId: prodId, uploaderUserId: ownerId, assetType: "reference",
      fileName: "测试剧本.pdf", mimeType: "application/pdf", storageType: "r2",
      r2Key: `assets/test/${shortId()}.pdf`, fileSize: 1000,
    });
    assetId = created.asset.id;
    const wiki = await createWiki({ productionId: prodId, title: `树里的文档-${shortId()}`, body: "x", createdBy: ownerId });
    wikiId = wiki.id;
  });

  it("wiki_tree 同时列出 [文档] 与 [文件]，各打各的 id 并标注可解析", async () => {
    const { wikiTree } = await import("@/lib/agent-tools/wiki-tools");
    const tree = await wikiTree(ownerId, prodId);
    expect(tree).toContain(`[文件] 测试剧本.pdf（资产 id: ${assetId}，可解析）`);
    expect(tree).toContain(`（id: ${wikiId}）`);
    expect(tree).toContain("[文档]");
    expect(tree).toContain("doc_outline"); // 尾注的类型→工具指路
  });

  it("wiki_read 收到资产 id：指路 doc_outline 而不是干巴巴没找到", async () => {
    const { wikiRead } = await import("@/lib/agent-tools/wiki-tools");
    const out = await wikiRead(ownerId, prodId, assetId);
    expect(out).toContain("资产文件");
    expect(out).toContain("doc_outline");
  });

  it("doc_outline 收到 wiki id：指路 wiki_read", async () => {
    const { docOutline } = await import("@/lib/agent-tools/doc-tools");
    const out = await docOutline(ownerId, prodId, wikiId);
    expect(out).toContain("wiki 文档");
    expect(out).toContain("wiki_read");
  });
});

describe("导入指引", () => {
  it("升级协议关键纪律齐备（防瘦身回退成案例大全）", () => {
    for (const kw of [
      "开工申报", "分诊", "丢弃也是一种裁决", "判例", "annotation", "泄压阀",
      "checkpoint", "复用优先于新建", "插入", "不是指令", "攒批",
    ]) {
      expect(DOC_IMPORT_GUIDE, `guide 应包含「${kw}」`).toContain(kw);
    }
  });
});
