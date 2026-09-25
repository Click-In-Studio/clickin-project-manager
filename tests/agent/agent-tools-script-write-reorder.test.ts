import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { makeProduction, cleanupProduction, makeScene, shortId } from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { applyPatchToDB } from "@/lib/script/script-patch-db";
import { loadProduction } from "@/lib/script/script-state-db";
import { runScriptProposal, previewScriptProposal } from "@/lib/agent/tools/script-write-tools";
import type { Block } from "@/lib/script/script-types";
import type { ScriptPatch } from "@/lib/script/script-ops";

// #680 线上实测：只调顺序的 script_propose_rewrite 被播报成「新增 0 / 修改 0 / 删除 0」，
// 模型以为没生效、放弃用它修错序。顺序变化必须落库并在卡片与结果里点名。

let prodId: string;
let versionId: string;
let ownerId: string;
let chId: string;
let s1: string, s2: string, s3: string;

const REWRITE = "production-script_propose_rewrite";

function stageBlock(id: string, content: string): Block {
  return { id, type: "stage", content, characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null };
}
const insertPatch = (block: Block, afterId: string): ScriptPatch =>
  ({ clientSeq: 1, blockOps: [{ op: "insert", block, afterId }], charOps: [], sceneOps: [] });

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  ({ prodId, versionId } = await makeProduction(ownerId));
  chId = await makeScene(prodId, versionId, { number: "1", name: "第一章" });
  s1 = randomUUID(); s2 = randomUUID(); s3 = randomUUID();
  await applyPatchToDB(prodId, versionId, insertPatch(stageBlock(s1, "第一句"), chId));
  await applyPatchToDB(prodId, versionId, insertPatch(stageBlock(s2, "第二句"), s1));
  await applyPatchToDB(prodId, versionId, insertPatch(stageBlock(s3, "第三句"), s2));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("script_propose_rewrite：只调顺序（#680）", () => {
  it("内容一字不改、只换 [b:] 行顺序：预览与结果都播报「顺序调整」，落库后顺序变了、id 不变", async () => {
    const args = {
      sectionId: chId,
      dialect: [`[m:${chId}] #`, `[b:${s3}] [台] 第三句`, `[b:${s1}] [台] 第一句`, `[b:${s2}] [台] 第二句`].join("\n"),
    };
    const preview = await previewScriptProposal(ownerId, prodId, REWRITE, args);
    expect(preview.error).toBeUndefined();
    const notes = preview.notes.join("\n");
    expect(notes).toMatch(/新增 0 块 \/ 修改 0 块 \/ 删除 0 块 \/ 保留 3 块 \/ 顺序调整 \d+ 块/);
    expect(notes).toMatch(/移：第三句/);

    const out = await runScriptProposal(ownerId, prodId, REWRITE, args);
    expect(out).toMatch(/顺序调整 \d+ 块/);

    const blocks = (await loadProduction(prodId, versionId))!.state.blocks;
    expect(blocks.map((b) => b.id)).toEqual([chId, s3, s1, s2]);
    expect(blocks.map((b) => b.content)).toEqual(["", "第三句", "第一句", "第二句"]);
  });

  it("顺序与现状相同则仍是「内容与现状相同」", async () => {
    const preview = await previewScriptProposal(ownerId, prodId, REWRITE, {
      sectionId: chId,
      dialect: [`[m:${chId}] #`, `[b:${s3}] [台] 第三句`, `[b:${s1}] [台] 第一句`, `[b:${s2}] [台] 第二句`].join("\n"),
    });
    expect(preview.error).toContain("内容与现状相同");
  });
});
