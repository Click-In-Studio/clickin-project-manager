import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { makeProduction, cleanupProduction, makeScene, makeCharacter, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember, applyPatchToDB, loadProduction } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { DENIED_NOT_MEMBER } from "@/lib/agent-tools/production-tools";
import { runScriptProposal, previewScriptProposal, SCRIPT_PROPOSE_TOOLS } from "@/lib/agent-tools/script-write-tools";
import { sectionEndIndex } from "@/lib/agent-tools/script-tools";
import { UNATTENDED_ALLOWED_TOOLS } from "@/lib/agent-runtime/tools";
import type { Block } from "@/lib/script-types";
import type { ScriptPatch } from "@/lib/script-ops";

// 剧本写面（P2）核心保证：①规划错误（方言/参数/业务）block 回模型、不落库；
// ②权限 = requiredPermissions(patch) 反推的钥匙经六步链判定，任一缺失整批不做；
// ③id 往返协议在写端兑现——保留的块 id 落库后不变（评论/cue/标签锚点不断）；
// ④无人值守缺省 deny：两个写工具都不在白名单里。

let prodId: string;
let versionId: string;
let ownerId: string;
let writerId: string;   // 成员 + script/*/blocks@view + @edit
let viewerId: string;   // 成员 + 仅 view
let outsiderId: string;
let chId: string;       // 章节标记
let charWang: string;
let d1: string, d2: string, d3: string, d4: string;

const REWRITE = "production-script_propose_rewrite";
const EDIT = "production-script_propose_edit_blocks";

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

async function grant(userId: string, type: string, id: string, sub: string, verb: string) {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'direct', $2)`,
    [prodId, userId, type, id, sub, verb]);
}

async function currentBlocks(): Promise<Block[]> {
  return (await loadProduction(prodId, versionId))!.state.blocks;
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  writerId = (await upsertFeishuUser(`test-open-${shortId()}`, `编剧${shortId()}`, null, false)).userId;
  viewerId = (await upsertFeishuUser(`test-open-${shortId()}`, `只读者${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
  ({ prodId, versionId } = await makeProduction(ownerId));
  await addProductionMember(prodId, writerId);
  await addProductionMember(prodId, viewerId);
  await grant(writerId, "script", "*", "blocks", "view");
  await grant(writerId, "script", "*", "blocks", "edit");
  await grant(viewerId, "script", "*", "blocks", "view");

  chId = await makeScene(prodId, versionId, { number: "1", name: "第一章" });
  charWang = await makeCharacter(prodId, versionId, { name: "老王" });

  d1 = randomUUID(); d2 = randomUUID(); d3 = randomUUID(); d4 = randomUUID();
  await applyPatchToDB(prodId, versionId, insertPatch(textBlock(d1, "你来了。", { characterIds: [charWang] }), chId));
  await applyPatchToDB(prodId, versionId, insertPatch(textBlock(d2, "灯光渐暗。", { type: "stage" }), d1));
  await applyPatchToDB(prodId, versionId, insertPatch(textBlock(d3, "画外音内容"), d2));
  await applyPatchToDB(prodId, versionId, insertPatch(textBlock(d4, "要被删掉的台词", { characterIds: [charWang] }), d3));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

/** 本套 fixture 的整段方言（改写前形态，测试内手工维护） */
function baseDialect(): string {
  return [
    `[m:${chId}] #`,
    `[b:${d1}] 老王：你来了。`,
    `[b:${d2}] [台] 灯光渐暗。`,
    `[b:${d3}] [白] 画外音内容`,
    `[b:${d4}] 老王：要被删掉的台词`,
  ].join("\n");
}

describe("权限门（安全边界在工具内）", () => {
  it("非成员 / 只读成员分别拒绝，措辞带键；未做任何变更", async () => {
    expect(await runScriptProposal(outsiderId, prodId, REWRITE, { sectionId: chId, dialect: baseDialect() })).toBe(DENIED_NOT_MEMBER);
    const denied = await runScriptProposal(viewerId, prodId, REWRITE, {
      sectionId: chId,
      dialect: baseDialect().replace("你来了。", "被偷改的台词"),
    });
    expect(denied).toContain("node:script/*/blocks@edit");
    expect(denied).toContain("未做任何变更");
    const blocks = await currentBlocks();
    expect(blocks.find((b) => b.id === d1)!.content).toBe("你来了。");
  });

  it("preview 与执行同一份判定：只读者 hasPermission=false 且 notes 带三态行", async () => {
    const args = { sectionId: chId, dialect: baseDialect().replace("你来了。", "预览改动") };
    const denied = await previewScriptProposal(viewerId, prodId, REWRITE, args);
    expect(denied.hasPermission).toBe(false);
    expect(denied.notes.join("\n")).toMatch(/[🔓📝⛔]/u);
    const ok = await previewScriptProposal(writerId, prodId, REWRITE, args);
    expect(ok.hasPermission).toBe(true);
    expect(ok.notes.join("\n")).toContain("修改 1 块");
  });

  it("无人值守缺省 deny：两个写工具都不在白名单", () => {
    expect(SCRIPT_PROPOSE_TOOLS.has(REWRITE)).toBe(true);
    expect(UNATTENDED_ALLOWED_TOOLS.has("production.script_propose_rewrite")).toBe(false);
    expect(UNATTENDED_ALLOWED_TOOLS.has("production.script_propose_edit_blocks")).toBe(false);
  });
});

describe("script_propose_rewrite：规划错误 block 不落库", () => {
  it("伪造 [b:id] / 删除标记锚点 / 与现状相同，各给专属错误", async () => {
    const forged = await runScriptProposal(writerId, prodId, REWRITE, {
      sectionId: chId, dialect: `${baseDialect()}\n[b:forged-id] 老王：混入`,
    });
    expect(forged).toContain("方言解析失败");
    expect(forged).toContain("不在本次改写的区间内");

    const noMarker = await runScriptProposal(writerId, prodId, REWRITE, {
      sectionId: chId, dialect: baseDialect().split("\n").slice(1).join("\n"),
    });
    expect(noMarker).toContain("标记锚点缺失");

    const same = await runScriptProposal(writerId, prodId, REWRITE, { sectionId: chId, dialect: baseDialect() });
    expect(same).toContain("内容与现状相同");

    const badSection = await runScriptProposal(writerId, prodId, REWRITE, { sectionId: "missing", dialect: baseDialect() });
    expect(badSection).toContain("scene_list");
  });
});

describe("script_propose_rewrite：落库与锚点保持", () => {
  it("改/增/删各就各位；保留块 id 不变（锚点不断）", async () => {
    const dialect = [
      `[m:${chId}] #`,
      `[b:${d1}] 老王（顿了顿）：你终于来了。`,
      `[new] [白] 插进来的画外音`,
      `[b:${d2}] [台] 灯光渐暗。`,
      `[b:${d3}] [白] 画外音内容`,
      // d4 省略 = 删除
    ].join("\n");
    const out = await runScriptProposal(writerId, prodId, REWRITE, { sectionId: chId, dialect });
    expect(out).toContain("新增 1 块、修改 1 块、删除 1 块");

    const blocks = await currentBlocks();
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const b1 = byId.get(d1)!;
    expect(b1.content).toBe("你终于来了。");
    expect(b1.characterIds).toEqual([charWang]);
    expect(b1.characterAnnotations).toEqual({ [charWang]: "顿了顿" });
    expect(byId.has(d4)).toBe(false);
    const order = blocks.map((b) => b.id);
    const inserted = blocks.find((b) => !([chId, d1, d2, d3] as string[]).includes(b.id))!;
    expect(inserted.content).toBe("插进来的画外音");
    expect(order.indexOf(inserted.id)).toBe(order.indexOf(d1) + 1);
    expect(order.indexOf(d2)).toBe(order.indexOf(inserted.id) + 1);
  });
});

describe("script_propose_edit_blocks：精修与守卫", () => {
  it("改说话人（#id 括注）/ 加舞台提示 / 段首插入，一批落库", async () => {
    const out = await runScriptProposal(writerId, prodId, EDIT, {
      updates: [{ blockId: d3, speakers: [`#${charWang}（低声）`], stageComment: "转身" }],
      inserts: [{ afterBlockId: chId, content: "开场白", speakers: ["老王"] }],
    });
    expect(out).toContain("已完成剧本改动");

    const blocks = await currentBlocks();
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const b3 = byId.get(d3)!;
    expect(b3.characterIds).toEqual([charWang]);
    expect(b3.characterAnnotations).toEqual({ [charWang]: "低声" });
    expect(b3.stageComment).toBe("转身");
    const order = blocks.map((b) => b.id);
    const opener = blocks[order.indexOf(chId) + 1];
    expect(opener.content).toBe("开场白");
    expect(opener.characterIds).toEqual([charWang]);
    expect(opener.sceneId).toBe(chId); // 归属重算：插进段里就挂到该段
  });

  it("标记不可经本工具改/删；批内删掉的块不能再当插入锚点；未知说话人报错", async () => {
    expect(await runScriptProposal(writerId, prodId, EDIT, {
      updates: [{ blockId: chId, content: "想改标记" }],
    })).toContain("scene_propose_*");
    expect(await runScriptProposal(writerId, prodId, EDIT, {
      deletes: [chId],
    })).toContain("scene_propose_*");
    expect(await runScriptProposal(writerId, prodId, EDIT, {
      deletes: [d3],
      inserts: [{ afterBlockId: d3, content: "挂在被删块后" }],
    })).toContain("被删除");
    expect(await runScriptProposal(writerId, prodId, EDIT, {
      inserts: [{ afterBlockId: d1, content: "谁说的", speakers: ["王五"] }],
    })).toContain("王五");
    // 以上全部未落库
    const blocks = await currentBlocks();
    expect(blocks.some((b) => b.id === d3)).toBe(true);
    expect(blocks.some((b) => b.content === "挂在被删块后")).toBe(false);
  });

  it("空操作与超限各有专属错误", async () => {
    expect(await runScriptProposal(writerId, prodId, EDIT, {})).toContain("全为空");
    expect(await runScriptProposal(writerId, prodId, EDIT, {
      deletes: Array.from({ length: 61 }, () => randomUUID()),
    })).toContain("最多");
  });
});

describe("sectionEndIndex：读写共用的段边界（纯函数，AI review #402-2）", () => {
  const mk = (id: string, type: Block["type"]): Block => ({
    id, type, content: "", characterIds: [], characterAnnotations: {}, lyric: false,
    sceneId: null, rehearsalMark: null,
    ...(type !== "dialogue" ? { markerMeta: { parentMarkerId: null } } : {}),
  });

  it("场段到下一个同级/更高级标记为止，吞掉内部排练标记；末段到文末", () => {
    //          0        1        2   3        4        5   6        7
    const blocks = [
      mk("ch1", "chapter_marker"),
      mk("sc1", "scene_marker"),
      mk("a", "dialogue"),
      mk("rh1", "rehearsal_marker"), // 低级标记：属于 sc1 段内部
      mk("b", "dialogue"),
      mk("sc2", "scene_marker"),     // 同级：sc1 段到此为止
      mk("c", "dialogue"),
      mk("ch2", "chapter_marker"),   // 更高级：sc2 段到此为止
    ];
    expect(sectionEndIndex(blocks, 1)).toBe(5);            // sc1 段 = [sc1, a, rh1, b]
    expect(sectionEndIndex(blocks, 3)).toBe(5);            // rh1 段 = [rh1, b]（到同级或更高级）
    expect(sectionEndIndex(blocks, 0)).toBe(7);            // ch1 段吞掉两场，到 ch2 为止
    expect(sectionEndIndex(blocks, 7)).toBe(blocks.length); // 末段到文末
  });
});
