import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { makeProduction, cleanupProduction, makeScene, makeCharacter, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, applyPatchToDB } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { DENIED_NOT_MEMBER } from "@/lib/agent-tools/production-tools";
import {
  scriptReadSection, scriptReadWindow, scriptSearch, scriptReadPage, DENIED_SCRIPT_VIEW,
} from "@/lib/agent-tools/script-tools";
import type { Block } from "@/lib/script-types";
import type { ScriptPatch } from "@/lib/script-ops";

// 剧本正文读面（P1）核心保证：①读门 = 剧本页门票（script/*/blocks@view，工具内实时判）；
// ②正文以剧本方言输出，[b:<id>] 携带块 id（后续引用/改写的锚点）；③页码是估算值，
// 页码粗着陆 + 相对窗口微调是刻意组合；④说话人按角色表解析展示。

let prodId: string;
let versionId: string;
let ownerId: string;
let viewerId: string;   // 成员 + script/*/blocks@view
let plainId: string;    // 成员、零 grant
let outsiderId: string;
let chapterId: string;
let charWang: string;   // 老王
let d1: string, d2: string, d3: string, d4: string;

function textBlock(id: string, content: string, extra: Partial<Block> = {}): Block {
  return {
    id, type: "dialogue", content,
    characterIds: [], characterAnnotations: {}, lyric: false,
    sceneId: null, rehearsalMark: null, ...extra,
  };
}

function insertPatch(block: Block, afterId: string | null): ScriptPatch {
  return { clientSeq: 1, blockOps: [{ op: "insert", block, afterId }], charOps: [], sceneOps: [] };
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  viewerId = (await upsertFeishuUser(`test-open-${shortId()}`, `剧本读者${shortId()}`, null, false)).userId;
  plainId = (await upsertFeishuUser(`test-open-${shortId()}`, `零权限${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
  ({ prodId, versionId } = await makeProduction(ownerId));
  await addProductionMember(prodId, viewerId);
  await addProductionMember(prodId, plainId);
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'script', '*', 'blocks', 'view', 'direct', $2)`,
    [prodId, viewerId],
  );

  chapterId = await makeScene(prodId, versionId, { number: "1", name: "第一章" });
  charWang = await makeCharacter(prodId, versionId, { name: "老王" });

  d1 = randomUUID();
  d2 = randomUUID();
  d3 = randomUUID();
  d4 = randomUUID();
  await applyPatchToDB(prodId, versionId, insertPatch(
    textBlock(d1, "你来了。", { characterIds: [charWang] }), chapterId));
  await applyPatchToDB(prodId, versionId, insertPatch(
    textBlock(d2, "灯光渐暗。", { type: "stage" }), d1));
  await applyPatchToDB(prodId, versionId, insertPatch(
    textBlock(d3, "画外音：月亮升起来了"), d2));
  await applyPatchToDB(prodId, versionId, insertPatch(
    textBlock(d4, "第一行\n第二行", { characterIds: [charWang], stageComment: "压低声音" }), d3));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("读门 = 剧本页门票（script/*/blocks@view）", () => {
  it("非成员 / 无钥匙成员分别拒绝，措辞带键", async () => {
    expect(await scriptReadSection(outsiderId, prodId, chapterId)).toBe(DENIED_NOT_MEMBER);
    expect(await scriptReadSection(plainId, prodId, chapterId)).toBe(DENIED_SCRIPT_VIEW);
    expect(await scriptSearch(plainId, prodId, { query: "月亮" })).toBe(DENIED_SCRIPT_VIEW);
    expect(await scriptReadWindow(plainId, prodId, d1)).toBe(DENIED_SCRIPT_VIEW);
    expect(await scriptReadPage(plainId, prodId, 1)).toBe(DENIED_SCRIPT_VIEW);
  });

  it("持钥匙成员与所有者可读", async () => {
    for (const uid of [viewerId, ownerId]) {
      const out = await scriptReadSection(uid, prodId, chapterId);
      expect(out).toContain(`[b:${d1}]`);
    }
  });
});

describe("script_read_section：整段方言输出", () => {
  it("包含标记锚点、带 id 的正文块、说话人与类型标记", async () => {
    const out = await scriptReadSection(viewerId, prodId, chapterId);
    expect(out).toContain(`[m:${chapterId}]`);
    expect(out).toContain(`[b:${d1}] 老王：你来了。`);
    expect(out).toContain(`[b:${d2}] [台] 灯光渐暗。`);
    expect(out).toContain(`[b:${d3}] [白] 画外音：月亮升起来了`);
    expect(out).toContain("| 第二行");           // 多行续行
    expect(out).toContain("[提示] 压低声音");     // stageComment
    expect(out).toContain("正文 4 块");
    expect(out).toContain("production.script_dialect_ref"); // 读路径指针
  });

  it("段 id 不存在时给出指路文案", async () => {
    const out = await scriptReadSection(viewerId, prodId, `missing-${shortId()}`);
    expect(out).toContain("scene_list");
  });
});

describe("script_read_window：相对窗口", () => {
  it("窗口取到前后块并给出继续行走的锚点", async () => {
    const out = await scriptReadWindow(viewerId, prodId, d3, 1, 1);
    expect(out).toContain(`锚点 [b:${d3}]`);
    expect(out).toContain(`[b:${d2}]`);
    expect(out).toContain(`[b:${d4}]`);
    expect(out).not.toContain("你来了。"); // d1 的正文不在窗口里（其 id 只出现在向前锚点提示中）
    expect(out).toContain(`继续向前：以 [b:${d1}] 为锚点`);
    expect(out).toContain("第一章");
  });

  it("块 id 不存在时给出指路文案", async () => {
    const out = await scriptReadWindow(viewerId, prodId, `missing-${shortId()}`);
    expect(out).toContain("[b:]");
  });
});

describe("script_search：搜索与说话人过滤", () => {
  it("命中正文并带块 id / 场次 / 说话人", async () => {
    const out = await scriptSearch(viewerId, prodId, { query: "月亮" });
    expect(out).toContain(`[b:${d3}]`);
    expect(out).toContain("〔无说话人〕");
    expect(out).toContain("月亮升起来了");
    expect(out).toContain("script_read_window");
  });

  it("stageComment 命中标注为提示", async () => {
    const out = await scriptSearch(viewerId, prodId, { query: "压低声音" });
    expect(out).toContain(`[b:${d4}]`);
    expect(out).toContain("提示:");
  });

  it("说话人过滤只保留该角色的块；未知角色名指路 character_list", async () => {
    const hit = await scriptSearch(viewerId, prodId, { query: "你来了", speaker: "老王" });
    expect(hit).toContain(`[b:${d1}]`);
    const miss = await scriptSearch(viewerId, prodId, { query: "月亮", speaker: "老王" });
    expect(miss).toContain("没有找到");
    const unknown = await scriptSearch(viewerId, prodId, { query: "月亮", speaker: "不存在的人" });
    expect(unknown).toContain("character_list");
  });
});

describe("script_read_page：估算页码", () => {
  it("第 1 页包含正文并声明估算口径 + 微调指路", async () => {
    const out = await scriptReadPage(viewerId, prodId, 1);
    expect(out).toContain("第 1 页（估算页码");
    expect(out).toContain(`[b:${d1}]`);
    expect(out).toContain("script_read_window");
  });

  it("超出范围的页码报告可用范围", async () => {
    const out = await scriptReadPage(viewerId, prodId, 9999);
    expect(out).toContain("没有内容");
    expect(out).toContain("估算页码范围");
  });
});
