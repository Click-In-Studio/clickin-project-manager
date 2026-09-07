/**
 * #461 第二档收敛（PR #463）的回归钉。
 *
 * 钉两件事：
 * 1. 轻量读口（loadVersionBlocks / loadVersionBlocksByIds / listTextBlockIdsByVersion /
 *    getScriptConfig）与 loadProduction 的装配**等价**——它们是同一份真相的窄投影，
 *    不是第二套实现；getScriptConfig 额外钉「纯读」：不做 loadProduction 的
 *    openingChapterMarkerId 写回。
 * 2. mention-resolve 改结构定点查后的语义保真：场号查询限定章/场域——scene 提及
 *    拿着排练记号 id 必须解析成 #[已删除]，不能借 labelByMarkerId 的混装解析出
 *    记号标签（旧 sceneNumById 只含章/场）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { POST as mentionResolvePOST } from "@/app/api/production/[id]/mention-resolve/route";
import {
  applyPatchToDB,
  getMarkerLabelIndex,
  getScriptConfig,
  listTextBlockIdsByVersion,
  loadProduction,
  loadVersionBlocks,
  loadVersionBlocksByIds,
} from "@/lib/db";
import type { Block } from "@/lib/script-types";
import type { ContentMentionAttrs } from "@/lib/mention-types";
import { makeProduction, makeScene, makeCharacter, cleanupProduction } from "./factories";

let owner: string;
let prodId: string;
let versionId: string;
let sceneId: string;
let rehearsalMarkerId: string;
/** 三块正文（场内顺序）；d1 挂一个角色，用来钉 script_character 装载 */
let dialogueIds: string[];
let charId: string;
const D1_CONTENT = "第一块：定点装载要把正文原样带回来。";

function dialogue(id: string, content: string, characterIds: string[] = []): Block {
  return {
    id, type: "dialogue", content, characterIds, characterAnnotations: {},
    lyric: false, sceneId: null, rehearsalMark: null,
  };
}

async function insert(block: Block, afterId: string | null) {
  await applyPatchToDB(prodId, versionId, {
    clientSeq: 1,
    blockOps: [{ op: "insert", block, afterId }],
    charOps: [],
    sceneOps: [],
  });
}

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

async function resolve(mentions: Partial<ContentMentionAttrs>[]): Promise<(string | null)[]> {
  const req = new NextRequest("http://localhost/api/production/x/mention-resolve", {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${createSession({ userId: owner, name: "测试", avatarUrl: null, isAdmin: false })}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mentions: mentions.map(m => ({ displayMode: null, aux: null, versionId: null, ...m })),
      versionId,
    }),
  });
  const res = await mentionResolvePOST(req, ctx());
  expect(res.status).toBe(200);
  return (await res.json() as { labels: (string | null)[] }).labels;
}

beforeAll(async () => {
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  owner = u.rows[0].id;
  ({ prodId, versionId } = await makeProduction(owner));
  sceneId = await makeScene(prodId, versionId, { number: "1", name: "过读场" });
  charId = await makeCharacter(prodId, versionId, { name: "证人甲" });

  // 结构：[章 marker] d1(挂角色) d2 [排练 marker] d3
  const d1 = randomUUID(); const d2 = randomUUID(); const d3 = randomUUID();
  dialogueIds = [d1, d2, d3];
  await insert(dialogue(d1, D1_CONTENT, [charId]), sceneId);
  await insert(dialogue(d2, "第二块。"), d1);
  rehearsalMarkerId = randomUUID();
  await insert({
    id: rehearsalMarkerId, type: "rehearsal_marker", content: "", characterIds: [], characterAnnotations: {},
    lyric: false, sceneId: null, rehearsalMark: null, markerMeta: {},
  }, d2);
  await insert(dialogue(d3, "第三块。"), rehearsalMarkerId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("getScriptConfig：同装配、纯读", () => {
  it("不做 openingChapterMarkerId 写回；装配结果与 loadProduction 等价", async () => {
    const readConfig = async () =>
      (await getPool().query<{ script_config: { openingChapterMarkerId?: string } | null }>(
        "SELECT script_config FROM version WHERE id = $1", [versionId],
      )).rows[0].script_config;

    // applyPatchToDB 在 marker 结构变化时就维护该键；手动清掉模拟遗留脏数据，
    // 才能分辨「getScriptConfig 纯读」与「loadProduction 写回自愈」两副面孔。
    await getPool().query(
      "UPDATE version SET script_config = script_config - 'openingChapterMarkerId' WHERE id = $1",
      [versionId],
    );
    expect((await readConfig())?.openingChapterMarkerId).toBeUndefined();
    const config = await getScriptConfig(prodId, versionId);
    expect(config?.openingChapterMarkerId).toBe(sceneId); // 兜底到第一章
    expect((await readConfig())?.openingChapterMarkerId).toBeUndefined(); // 纯读：没写回

    const full = await loadProduction(prodId, versionId);
    expect(full!.state.config).toEqual(config); // 单一装配口，逐键等价
    expect((await readConfig())?.openingChapterMarkerId).toBe(sceneId); // loadProduction 的写回仍在
  });

  it("版本不存在时返回 null（与 loadProduction 的哨兵同口径）", async () => {
    expect(await getScriptConfig(prodId, "ver_missing")).toBeNull();
  });
});

describe("blocks 轻量读口与 loadProduction 等价", () => {
  it("loadVersionBlocks：blocks/sortKeys/snapshotIds 与整本装载逐项等价", async () => {
    const [light, full] = [await loadVersionBlocks(versionId), (await loadProduction(prodId, versionId))!];
    expect(light.blocks).toEqual(full.state.blocks);
    expect(light.sortKeys).toEqual(full.sortKeys);
    expect(light.snapshotIds).toEqual(full.snapshotIds);
  });

  it("loadVersionBlocksByIds：只回请求的行，正文与角色挂载齐备", async () => {
    const picked = await loadVersionBlocksByIds(versionId, [dialogueIds[0], dialogueIds[2]]);
    expect(picked.map(b => b.id)).toEqual([dialogueIds[0], dialogueIds[2]]); // 正文顺序
    expect(picked[0].content).toBe(D1_CONTENT);
    expect(picked[0].characterIds).toEqual([charId]);
    expect(await loadVersionBlocksByIds(versionId, [])).toEqual([]);
  });

  it("listTextBlockIdsByVersion：正文顺序、不含 marker", async () => {
    const ids = await listTextBlockIdsByVersion(versionId);
    // 与整本装载的非 marker 投影逐项等价（marker 后自动补的空块也是正文块，一并计入）
    const full = (await loadProduction(prodId, versionId))!;
    const markerTypes = new Set(["chapter_marker", "scene_marker", "rehearsal_marker"]);
    expect(ids).toEqual(full.state.blocks.filter(b => !markerTypes.has(b.type)).map(b => b.id));
    expect(ids).not.toContain(sceneId);
    expect(ids).not.toContain(rehearsalMarkerId);
    for (const id of dialogueIds) expect(ids).toContain(id);
  });
});

describe("mention-resolve 结构定点查的语义保真", () => {
  it("scene 提及拿排练记号 id 解析成 #[已删除]，不借混装标签", async () => {
    const [label] = await resolve([{ kind: "scene", id: rehearsalMarkerId }]);
    expect(label).toBe("#[已删除]");
  });

  it("scene/rehearsal 提及解析出各自的标签", async () => {
    const labels = await getMarkerLabelIndex(versionId);
    const sceneLabel = labels.labelByMarkerId.get(sceneId);
    const rehearsalLabel = labels.labelByMarkerId.get(rehearsalMarkerId);
    expect(sceneLabel).toBeTruthy();
    expect(rehearsalLabel).toBeTruthy();
    const resolved = await resolve([
      { kind: "scene", id: sceneId },
      { kind: "rehearsal", id: rehearsalMarkerId },
    ]);
    expect(resolved).toEqual([`#${sceneLabel}`, `#${rehearsalLabel}`]);
  });

  it("block 提及 scene 模式：场内序号按正文顺序（marker 不占位）", async () => {
    const labels = await getMarkerLabelIndex(versionId);
    const sceneLabel = labels.labelByMarkerId.get(sceneId)!;
    const resolved = await resolve([{ kind: "block", id: dialogueIds[2], displayMode: "scene" }]);
    expect(resolved).toEqual([`#${sceneLabel}-3`]); // d3 是场内第 3 块正文，排练 marker 不计数
  });

  it("已删除的 block id 解析成 #[已删除]", async () => {
    const [label] = await resolve([{ kind: "block", id: randomUUID(), displayMode: "scene" }]);
    expect(label).toBe("#[已删除]");
  });
});
