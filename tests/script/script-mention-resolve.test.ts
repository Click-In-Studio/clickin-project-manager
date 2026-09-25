// 剧本域引用的标签解析（#689）：场次给「场号 + 场名」、剧本片段给「坐标 + 谁说了
// 什么」、无剧本权限的成员拿到「无权查看」哨兵而不是 null。
//
// 在此之前 scene / block 两个 kind 的标签解析一条直接用例都没有（只有页模式 url
// 那条间接断言），而它们恰恰是 #689 里显示最差的两个。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { POST as mentionResolvePOST } from "@/app/api/production/[id]/mention-resolve/route";
import { applyPatchToDB } from "@/lib/script/script-patch-db";
import { loadBlockMentionDigests } from "@/lib/script/script-block-read-db";
import { loadMarkerNaming } from "@/lib/script/script-marker-label-db";
import { MENTION_SENTINEL } from "@/lib/editor/mention-display";
import type { Block } from "@/lib/script/script-types";
import type { ContentMentionAttrs } from "@/lib/editor/mention-types";
import { makeProduction, makeScene, makeCharacter, cleanupProduction } from "../_support/factories";

let owner: string;
let outsiderMember: string;
let prodId: string;
let versionId: string;
let chapterId: string;
let sceneId: string;
let charId: string;
/** 场内三块：带角色的对白、不带角色的舞台指示、空块 */
let spokenId: string;
let stageId: string;
let emptyId: string;

const SCENE_NAME = "码头夜戏";
const SCENE_SYNOPSIS = "证人甲在码头被拦下，第一次说出那句话。";
const SPOKEN = "你到底想让我说什么，我已经全讲完了";
const STAGE = "灯渐暗，远处传来汽笛";

function dialogue(id: string, content: string, characterIds: string[] = []): Block {
  return {
    id, type: "dialogue", content, characterIds, characterAnnotations: {},
    lyric: false, sceneId: null, rehearsalMark: null,
  };
}

async function insert(block: Block, afterId: string | null) {
  await applyPatchToDB(prodId, versionId, {
    clientSeq: 1, blockOps: [{ op: "insert", block, afterId }], charOps: [], sceneOps: [],
  });
}

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

type Resolved = { labels: (string | null)[]; urls: (string | null)[]; details: (string | null)[] };

async function resolve(
  mentions: Partial<ContentMentionAttrs>[], userId = owner,
): Promise<Resolved> {
  const req = new NextRequest("http://localhost/api/production/x/mention-resolve", {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mentions: mentions.map(m => ({ displayMode: null, aux: null, versionId: null, ...m })),
      versionId,
    }),
  });
  const res = await mentionResolvePOST(req, ctx());
  expect(res.status).toBe(200);
  return await res.json() as Resolved;
}

beforeAll(async () => {
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  owner = u.rows[0].id;
  ({ prodId, versionId } = await makeProduction(owner));

  // 一个零授权的成员：过得了 production 门，过不了 script blocks@view
  const m = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  outsiderMember = m.rows[0].id;
  await getPool().query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')",
    [prodId, outsiderMember],
  );

  chapterId = await makeScene(prodId, versionId, { number: "1", name: "第一幕" });
  charId = await makeCharacter(prodId, versionId, { name: "证人甲" });

  // 章下挂一枚有名有提纲的场，场里三块正文
  sceneId = randomUUID();
  await insert({
    id: sceneId, type: "scene_marker", content: "", characterIds: [], characterAnnotations: {},
    lyric: false, sceneId: null, rehearsalMark: null,
    markerMeta: { parentMarkerId: chapterId, name: SCENE_NAME, synopsis: SCENE_SYNOPSIS },
  }, chapterId);
  spokenId = randomUUID(); stageId = randomUUID(); emptyId = randomUUID();
  await insert(dialogue(spokenId, SPOKEN, [charId]), sceneId);
  await insert({ ...dialogue(stageId, STAGE), type: "stage" }, spokenId);
  await insert(dialogue(emptyId, ""), stageId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("scene 引用：场号 + 场名", () => {
  it("场名进标签、提纲进悬浮；只有场号的场退回纯场号", async () => {
    const { labels, details, urls } = await resolve([{ kind: "scene", id: sceneId }, { kind: "scene", id: chapterId }]);
    expect(labels[0]).toBe(`#0-1 ${SCENE_NAME}`);
    expect(details[0]).toBe(SCENE_SYNOPSIS);
    expect(urls[0]).toContain("/script");
    // 章（makeScene 造的是 chapter_marker）有名字，没提纲
    expect(labels[1]).toBe("#0 第一幕");
    expect(details[1]).toBeNull();
  });

  it("场名改了标签跟着改——标签不是编辑期快照", async () => {
    const before = (await resolve([{ kind: "scene", id: sceneId }])).labels[0];
    await getPool().query(
      `UPDATE script SET marker_meta = marker_meta || '{"name":"改过的场名"}'::jsonb
       WHERE id IN (SELECT snapshot_id FROM script_version WHERE version_id = $1 AND block_id = $2)`,
      [versionId, sceneId],
    );
    expect((await resolve([{ kind: "scene", id: sceneId }])).labels[0]).toBe("#0-1 改过的场名");
    // 还原，后面的用例还要用原名
    await getPool().query(
      `UPDATE script SET marker_meta = marker_meta || $3::jsonb
       WHERE id IN (SELECT snapshot_id FROM script_version WHERE version_id = $1 AND block_id = $2)`,
      [versionId, sceneId, JSON.stringify({ name: SCENE_NAME })],
    );
    expect((await resolve([{ kind: "scene", id: sceneId }])).labels[0]).toBe(before);
  });

  it("拿排练记号 id 当场次引用仍解析成已删除，不借混装标签", async () => {
    const markerId = randomUUID();
    await insert({
      id: markerId, type: "rehearsal_marker", content: "", characterIds: [], characterAnnotations: {},
      lyric: false, sceneId: null, rehearsalMark: null, markerMeta: {},
    }, emptyId);
    expect((await resolve([{ kind: "scene", id: markerId }])).labels[0]).toBe(MENTION_SENTINEL.deleted);
  });
});

describe("block 引用：坐标 + 谁说了什么", () => {
  it("对白块带角色名与摘要，整句进悬浮", async () => {
    const { labels, details, urls } = await resolve([{ kind: "block", displayMode: "scene", id: spokenId }]);
    expect(labels[0]).toBe("#0-1-1 证人甲：你到底想让我说什么…");  // 摘要按字数截断，切口的逗号吃掉
    expect(details[0]).toBe(`证人甲：${SPOKEN}`);                  // 悬浮给整句
    expect(urls[0]).toContain(`#block-${spokenId}`);
  });

  it("舞台指示没有说话人，只有摘要", async () => {
    const { labels } = await resolve([{ kind: "block", displayMode: "scene", id: stageId }]);
    expect(labels[0]).toBe("#0-1-2 灯渐暗，远处传来汽笛");
    expect(labels[0]).not.toContain("证人甲");
  });

  it("空块只剩坐标——摘要缺了不许把 chip 变成空壳", async () => {
    const { labels, details } = await resolve([{ kind: "block", displayMode: "scene", id: emptyId }]);
    expect(labels[0]).toBe("#0-1-3");
    expect(details[0]).toBeNull();
  });

  it("同一块的 scene / page 两种展示模式给不同坐标，摘要相同", async () => {
    const { labels } = await resolve([
      { kind: "block", displayMode: "scene", id: spokenId },
      { kind: "block", displayMode: "page", id: spokenId },
    ]);
    expect(labels[0]).toMatch(/^#0-1-1 /);
    expect(labels[1]).toMatch(/^#p\.\d+-\d+ /);
    expect(labels[0]).not.toBe(labels[1]);
    for (const l of labels) expect(l).toContain("证人甲：你到底想让我说什么");
  });

  it("不存在的 block id → 已删除哨兵，且不给可点的链接", async () => {
    const { labels, urls } = await resolve([{ kind: "block", displayMode: "scene", id: randomUUID() }]);
    expect(labels[0]).toBe(MENTION_SENTINEL.deleted);
    expect(urls[0]).toBeNull();
  });
});

// 路由那几条走的是「一块一个角色」的常态。说话人的取位规则（按 position 取第一位、
// 跳过没名字的）在多角色块上才看得出来，这里直接对读口下断言。
describe("loadBlockMentionDigests：说话人取位", () => {
  it("多位角色只取 position 最小的那一位，空名字不顶位", async () => {
    const solo = await makeCharacter(prodId, versionId, { name: "证人乙" });
    const nameless = await makeCharacter(prodId, versionId, { name: "临时角色" });
    await getPool().query(
      "UPDATE character_version SET name = '' WHERE character_id = $1 AND version_id = $2",
      [nameless, versionId],
    );
    const chorusId = randomUUID();
    // characterIds 的先后即 script_character.position
    await insert(dialogue(chorusId, "我们一起说这句", [nameless, charId, solo]), emptyId);

    const digests = await loadBlockMentionDigests(versionId, [chorusId, spokenId]);
    expect(digests.get(chorusId)).toEqual({ content: "我们一起说这句", speaker: "证人甲" });
    expect(digests.get(spokenId)!.speaker).toBe("证人甲");
    expect(digests.size).toBe(2);
  });

  it("不传 id 不打库；不存在的 id 不进结果", async () => {
    expect(await loadBlockMentionDigests(versionId, [])).toEqual(new Map());
    expect((await loadBlockMentionDigests(versionId, [randomUUID()])).size).toBe(0);
  });
});

describe("loadMarkerNaming：场名与提纲", () => {
  it("空字符串归一成 null，让标签退回纯场号而不是拼一个空格", async () => {
    const naming = await loadMarkerNaming(versionId, [sceneId, chapterId]);
    expect(naming.get(sceneId)).toEqual({ name: SCENE_NAME, synopsis: SCENE_SYNOPSIS });
    expect(naming.get(chapterId)!.synopsis).toBeNull(); // 章没写提纲 → 不是 ""
    expect(await loadMarkerNaming(versionId, [])).toEqual(new Map());
  });
});

describe("无剧本权限：哨兵而不是 null", () => {
  it("零授权成员的剧本域引用拿到「无权查看」，渲染端不必再猜", async () => {
    const { labels, urls } = await resolve([
      { kind: "scene", id: sceneId },
      { kind: "block", displayMode: "scene", id: spokenId },
      { kind: "asset", id: "asset_missing" },
    ], outsiderMember);
    for (let i = 0; i < 3; i++) {
      expect(labels[i]).toBe(MENTION_SENTINEL.noAccess);
      expect(urls[i]).toBeNull();
    }
    // 标签里不含任何正文内容
    expect(labels.join("")).not.toContain("证人甲");
    expect(labels.join("")).not.toContain(SCENE_NAME);
  });

  it("owner 旁路照旧：同一批引用在 owner 眼里是活标签", async () => {
    const { labels } = await resolve([{ kind: "block", displayMode: "scene", id: spokenId }]);
    expect(labels[0]).toContain("证人甲");
  });
});
