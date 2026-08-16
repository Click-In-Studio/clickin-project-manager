// 文档库级 SSE 帧的接线测试：任何来源的结构变化（增/改名/移动/换标签/删）
// 都要推 library 帧，而正文 autosave 绝不能推——后者每几秒一次，推了就是给
// 所有在线页面加一个高频全树刷新源。
//
// 频道复用同一个 SSE 注册表（topic = library:<productionId>），所以这里直接
// 注册一个假 push 当订阅者，断言收到的帧。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser } from "@/lib/db";
import { registerWikiLibrarySSE, type WikiLibraryChange } from "@/lib/wiki-collab";
import { createWiki, updateWiki, deleteWiki } from "@/lib/wiki-db";

let prodId: string;
let ownerId: string;
let unsubscribe: (() => void) | null = null;
const frames: WikiLibraryChange[] = [];

function takeFrames(): WikiLibraryChange[] {
  const out = [...frames];
  frames.length = 0;
  return out;
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  unsubscribe = registerWikiLibrarySSE(prodId, "test-conn", (frame) => {
    // frame 形如 "event: library\ndata: {...}\n\n"
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (line) frames.push(JSON.parse(line.slice(5)) as WikiLibraryChange);
  });
});

afterAll(async () => {
  unsubscribe?.();
  await cleanupProduction(prodId).catch(() => {});
});

describe("wiki 库级广播", () => {
  it("createWiki 推 created 帧", async () => {
    const doc = await createWiki({ productionId: prodId, title: "灯光", body: "", parentId: null, createdBy: ownerId });
    expect(takeFrames()).toEqual([{ kind: "created", wikiId: doc.id }]);
    await deleteWiki(doc.id, prodId);
    takeFrames();
  });

  it("改标题 / 换标签 / 移动都推 updated 帧", async () => {
    const doc = await createWiki({ productionId: prodId, title: "音响", body: "", parentId: null, createdBy: ownerId });
    const parent = await createWiki({ productionId: prodId, title: "技术", body: "", parentId: null, createdBy: ownerId });
    takeFrames();

    await updateWiki(doc.id, prodId, { title: "音响设计" }, ownerId);
    expect(takeFrames()).toEqual([{ kind: "updated", wikiId: doc.id }]);

    await updateWiki(doc.id, prodId, { tags: ["v2"] }, ownerId);
    expect(takeFrames()).toEqual([{ kind: "updated", wikiId: doc.id }]);

    await updateWiki(doc.id, prodId, { parentId: parent.id }, ownerId);
    expect(takeFrames()).toEqual([{ kind: "updated", wikiId: doc.id }]);

    await deleteWiki(doc.id, prodId);
    await deleteWiki(parent.id, prodId);
    takeFrames();
  });

  it("只改正文（autosave 的常态）不推库级帧", async () => {
    const doc = await createWiki({ productionId: prodId, title: "服装", body: "", parentId: null, createdBy: ownerId });
    takeFrames();
    await updateWiki(doc.id, prodId, { body: "第一稿" }, ownerId);
    await updateWiki(doc.id, prodId, { body: "第二稿" }, ownerId);
    expect(takeFrames()).toEqual([]);
    await deleteWiki(doc.id, prodId);
    takeFrames();
  });

  it("deleteWiki 推 deleted 帧（正开着这篇的人靠它离场）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "道具", body: "", parentId: null, createdBy: ownerId });
    takeFrames();
    expect(await deleteWiki(doc.id, prodId)).toEqual({ ok: true });
    expect(takeFrames()).toEqual([{ kind: "deleted", wikiId: doc.id }]);
  });

  it("删除被拒（锚点/挂载/不存在）不推帧", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(await deleteWiki(missing, prodId)).toEqual({ ok: false, reason: "not_found" });
    expect(takeFrames()).toEqual([]);
  });
});
