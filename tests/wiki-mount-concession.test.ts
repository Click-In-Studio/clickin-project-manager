// wiki 挂载让渡（#420 第二批 PR-A）：文档的 node 被挂到 scene/block/cue/event 上，
// 宿主可见 ⇒ 文档可读（与 asset 挂载让渡同一判定核 lib/node/host-visibility）。
// 矩阵覆盖四通道 × 单点/集合式同源 × 撤挂收缩 × 枚举面不投票；
// 另验 asset 侧随共享核补上的 event 通道（原 asset_mount 时代 event 挂载不让渡）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { createWiki } from "@/lib/wiki/content";
import { canViewWiki, listVisibleWikiIds } from "@/lib/wiki/perm";
import { canViewAsset, filterVisibleAssets } from "@/lib/asset/perm";
import { createAsset } from "@/lib/asset/db";
import { listEnumerableNodeIds } from "@/lib/node/perm";
import {
  addNodeMount, removeNodeMount, listNodesByMountPoint, getAssetsByMountPoint,
} from "@/lib/node/mount";
import type { PermissionContext } from "@/lib/permissions";
import { makeProduction, cleanupProduction, makeScene, makeBlocks, shortId } from "./factories";

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

function ctxOf(userId: string): PermissionContext {
  return {
    userId, isAdmin: false, isOwner: false,
    memberPermissions: new Set(), overrides: new Map(),
    deptIds: [], pocDeptIds: [], deptFreeApprovalZone: new Set(),
    activeGrants: new Set(),
  };
}

async function grant(
  userId: string, prodId: string,
  resourceType: string, resourceId: string, sub: string, verb: string,
) {
  await getPool().query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, $3, $4, $5, $6, 'auto')`,
    [prodId, userId, resourceType, resourceId, sub, verb],
  );
}

let prodId: string;
let versionId: string;
let author: string;
let sceneViewer: string;   // scene meta@view
let scripter: string;      // script */blocks@view
let cueViewer: string;     // cue_list <id> cues@view
let eventViewer: string;   // event */meta@view（域票）
let nobody: string;        // 无任何票
let sceneId: string;
let blockId: string;
let cueListId: string;
let cueStableId: string;
let eventId: string;

/** 每个用例造自己的私有文档（listable=false：枚举面基线为不可枚举）。 */
async function makePrivateDoc(title: string): Promise<{ wikiId: string; nodeId: string }> {
  const doc = await createWiki({
    productionId: prodId, title, createdBy: author, listable: false,
  });
  return { wikiId: doc.id, nodeId: doc.nodeId };
}

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
  [author, sceneViewer, scripter, cueViewer, eventViewer, nobody] = await Promise.all(
    Array.from({ length: 6 }, newUser),
  );
  sceneId = await makeScene(prodId, versionId);
  [blockId] = await makeBlocks(prodId, versionId, 1);

  cueListId = shortId();
  cueStableId = shortId();
  await getPool().query(
    `INSERT INTO cue_list (id, production_id, name, created_by) VALUES ($1, $2, '让渡测试表', $3)`,
    [cueListId, prodId, author],
  );
  await getPool().query(
    `INSERT INTO cue (id, cue_list_id, number, start_kind, end_kind, cue_id)
     VALUES ($1, $2, '1', 'gap', 'gap', $3)`,
    [shortId(), cueListId, cueStableId],
  );

  eventId = shortId();
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by) VALUES ($1, $2, '让渡测试事件', $3)`,
    [eventId, prodId, author],
  );

  await Promise.all([
    grant(sceneViewer, prodId, "scene", sceneId, "meta", "view"),
    grant(scripter, prodId, "script", "*", "blocks", "view"),
    grant(cueViewer, prodId, "cue_list", cueListId, "cues", "view"),
    grant(eventViewer, prodId, "event", "*", "meta", "view"),
  ]);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("wiki 挂载让渡四通道（单点/集合式同源）", () => {
  it("scene 挂载：scene meta@view 持有者可读；无票者不可读；撤挂即收缩", async () => {
    const { wikiId, nodeId } = await makePrivateDoc("scene让渡");
    expect(await canViewWiki(ctxOf(sceneViewer), prodId, wikiId)).toBe(false);

    const mount = await addNodeMount({
      nodeId, productionId: prodId, mountType: "scene", mountId: sceneId, createdBy: author,
    });
    expect(await canViewWiki(ctxOf(sceneViewer), prodId, wikiId)).toBe(true);
    expect(await canViewWiki(ctxOf(nobody), prodId, wikiId)).toBe(false);
    const vis = await listVisibleWikiIds(ctxOf(sceneViewer), prodId);
    expect(vis.wildcard || vis.ids.has(wikiId)).toBe(true);

    await removeNodeMount(mount.id);
    expect(await canViewWiki(ctxOf(sceneViewer), prodId, wikiId)).toBe(false);
    const after = await listVisibleWikiIds(ctxOf(sceneViewer), prodId);
    expect(after.ids.has(wikiId)).toBe(false);
  });

  it("block 挂载：script */blocks@view 持有者可读", async () => {
    const { wikiId, nodeId } = await makePrivateDoc("block让渡");
    await addNodeMount({
      nodeId, productionId: prodId, mountType: "block", mountId: blockId, createdBy: author,
    });
    expect(await canViewWiki(ctxOf(scripter), prodId, wikiId)).toBe(true);
    expect(await canViewWiki(ctxOf(sceneViewer), prodId, wikiId)).toBe(false);
  });

  it("cue 挂载（稳定 cue_id）：所在 cue_list 的 cues@view 持有者可读", async () => {
    const { wikiId, nodeId } = await makePrivateDoc("cue让渡");
    await addNodeMount({
      nodeId, productionId: prodId, mountType: "cue", mountId: cueStableId, createdBy: author,
    });
    expect(await canViewWiki(ctxOf(cueViewer), prodId, wikiId)).toBe(true);
    expect(await canViewWiki(ctxOf(nobody), prodId, wikiId)).toBe(false);
    const vis = await listVisibleWikiIds(ctxOf(cueViewer), prodId);
    expect(vis.ids.has(wikiId)).toBe(true);
  });

  it("event 挂载：event 域 view 持有者可读", async () => {
    const { wikiId, nodeId } = await makePrivateDoc("event让渡");
    await addNodeMount({
      nodeId, productionId: prodId, mountType: "event", mountId: eventId, createdBy: author,
    });
    expect(await canViewWiki(ctxOf(eventViewer), prodId, wikiId)).toBe(true);
    expect(await canViewWiki(ctxOf(nobody), prodId, wikiId)).toBe(false);
  });
});

describe("硬不变量：边不投枚举票", () => {
  it("挂载后文档可读，但其 node 仍不可枚举（不进树）", async () => {
    const { wikiId, nodeId } = await makePrivateDoc("枚举面不动");
    await addNodeMount({
      nodeId, productionId: prodId, mountType: "scene", mountId: sceneId, createdBy: author,
    });
    expect(await canViewWiki(ctxOf(sceneViewer), prodId, wikiId)).toBe(true);
    const e = await listEnumerableNodeIds(ctxOf(sceneViewer), prodId);
    expect(e.wildcard).toBe(false);
    expect(e.ids.has(nodeId)).toBe(false);
  });
});

describe("asset 侧随共享核补上的 event 通道", () => {
  it("私有资产挂到 event：能力票 ∧ event 域票 ⇒ 可见；缺任一不可见", async () => {
    const a = await createAsset({
      productionId: prodId, uploaderUserId: author, assetType: "reference",
      fileName: "event-mounted.pdf", mimeType: "application/pdf",
      storageType: "r2", isPublic: false,
    });
    await grant(eventViewer, prodId, "asset", "*", "meta", "view");
    // 挂载前：能力票单独不越隐私
    expect(await canViewAsset(ctxOf(eventViewer), prodId, { id: a.asset.id }, "meta")).toBe(false);

    await addNodeMount({
      nodeId: a.nodeId, productionId: prodId, mountType: "event", mountId: eventId, createdBy: author,
    });
    expect(await canViewAsset(ctxOf(eventViewer), prodId, { id: a.asset.id }, "meta")).toBe(true);
    const set = await filterVisibleAssets(ctxOf(eventViewer), prodId, [{ id: a.asset.id }]);
    expect(set.map(x => x.id)).toContain(a.asset.id);
    // event 域票在手但无 asset 能力票 ⇒ 仍不可见（让渡不豁免能力票）
    expect(await canViewAsset(ctxOf(nobody), prodId, { id: a.asset.id }, "meta")).toBe(false);
  });
});

describe("挂载点读面泛化 listNodesByMountPoint", () => {
  it("同一挂载点回 asset+wiki 两种 kind；getAssetsByMountPoint 仍只投影 asset", async () => {
    const point = shortId(); // 独立 scene 挂载点，避免与前面用例串
    const { nodeId: wikiNodeId } = await makePrivateDoc("读面泛化");
    const a = await createAsset({
      productionId: prodId, uploaderUserId: author, assetType: "reference",
      fileName: "panel.wav", mimeType: "audio/wav",
      storageType: "r2", isPublic: false,
    });
    await addNodeMount({
      nodeId: wikiNodeId, productionId: prodId, mountType: "scene", mountId: point, createdBy: author,
    });
    await addNodeMount({
      nodeId: a.nodeId, productionId: prodId, mountType: "scene", mountId: point, createdBy: author,
    });

    const entries = await listNodesByMountPoint(prodId, "scene", point);
    expect(entries).toHaveLength(2);
    const kinds = entries.map(e => e.kind).sort();
    expect(kinds).toEqual(["asset", "wiki"]);
    const wikiEntry = entries.find(e => e.kind === "wiki")!;
    expect(wikiEntry.wiki?.title).toBe("读面泛化");
    expect(wikiEntry.asset).toBeNull();
    const assetEntry = entries.find(e => e.kind === "asset")!;
    expect(assetEntry.asset?.id).toBe(a.asset.id);
    expect(assetEntry.wiki).toBeNull();

    const assetsOnly = await getAssetsByMountPoint(prodId, "scene", point);
    expect(assetsOnly).toHaveLength(1);
    expect(assetsOnly[0].asset.id).toBe(a.asset.id);
  });
});
