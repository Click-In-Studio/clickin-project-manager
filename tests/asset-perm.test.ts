import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setPolicies } from "@/lib/policy-db";
import { POLICY_ON, POLICY_OFF } from "@/lib/policy-keys";
import { createAsset } from "@/lib/asset/db";
import { canViewAsset, filterVisibleAssets, canPublishAsset, canCreateShareToken } from "@/lib/asset/perm";
import { addNodeMount, removeNodeMount, getNodeMount, listNodeMounts } from "@/lib/node/mount";
import { getNodeByAssetId } from "@/lib/node/db";
import type { PermissionContext } from "@/lib/permissions";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// 批D：隐私/公开模型判定
// 可见 = publication@view（越隐私）∨ 能力票 ∧ (is_public ∨ ∃挂载:宿主可见)

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

async function giveTicket(userId: string, prodId: string, sub: string, verb: string, id = "*") {
  await getPool().query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'asset', $3, $4, $5, 'auto')
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false DO NOTHING`,
    [prodId, userId, id, sub, verb],
  );
}

let prodId: string;
let uploader: string;
let member: string;      // 有能力票，无授权
let outsider: string;    // 无能力票
let librarian: string;   // publication@view 显式通配（越隐私）
let privateAssetId: string;
let publicAssetId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [uploader, member, outsider, librarian] = await Promise.all([newUser(), newUser(), newUser(), newUser()]);

  const priv = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "private.pdf", mimeType: "application/pdf",
    storageType: "r2", isPublic: false,
  });
  privateAssetId = priv.asset.id;
  const pub = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "public.pdf", mimeType: "application/pdf",
    storageType: "r2", isPublic: true,
  });
  publicAssetId = pub.asset.id;

  await giveTicket(member, prodId, "meta", "view");
  await giveTicket(member, prodId, "file", "view");
  await giveTicket(librarian, prodId, "meta", "view");
  await giveTicket(librarian, prodId, "publication", "view");  // 保留段显式通配=真 any 票
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("能力票∧结构合取", () => {
  it("能力票 + is_public → 可见", async () => {
    expect(await canViewAsset(ctxOf(member), prodId, { id: publicAssetId }, "meta")).toBe(true);
  });

  it("能力票单独不越隐私（未挂载私有 → 不可见）", async () => {
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId }, "meta")).toBe(false);
  });

  it("无能力票即使公开也不可见", async () => {
    expect(await canViewAsset(ctxOf(outsider), prodId, { id: publicAssetId }, "meta")).toBe(false);
  });

  it("publication@view 显式通配越隐私（无需能力票的 file 面也可）", async () => {
    expect(await canViewAsset(ctxOf(librarian), prodId, { id: privateAssetId }, "file")).toBe(true);
  });

  it("创建者行集：uploader 自见隐私资产（实例 publication@view）", async () => {
    expect(await canViewAsset(ctxOf(uploader), prodId, { id: privateAssetId }, "meta")).toBe(true);
  });
});

describe("结构让渡（#420：node 可枚举 ≡ 原 production 根共享区）", () => {
  it("置 listable 后能力票持有者可见；关掉回到隐私", async () => {
    await getPool().query(
      `UPDATE node SET listable = true WHERE asset_id = $1`, [privateAssetId]);
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId }, "meta")).toBe(true);
    // 无能力票者依然不可见（让渡不豁免能力票）
    expect(await canViewAsset(ctxOf(outsider), prodId, { id: privateAssetId }, "meta")).toBe(false);

    await getPool().query(
      `UPDATE node SET listable = false WHERE asset_id = $1`, [privateAssetId]);
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId }, "meta")).toBe(false);
  });
});

describe("filterVisibleAssets 集合式一致性", () => {
  it("member 看到公开不看到隐私；librarian 全见", async () => {
    const assets = [
      { id: privateAssetId },
      { id: publicAssetId },
    ];
    const forMember = await filterVisibleAssets(ctxOf(member), prodId, assets);
    expect(forMember.map(a => a.id)).toEqual([publicAssetId]);
    const forLibrarian = await filterVisibleAssets(ctxOf(librarian), prodId, assets);
    expect(forLibrarian.map(a => a.id).sort()).toEqual([privateAssetId, publicAssetId].sort());
  });
});

describe("双门与分享规则", () => {
  it("uploader 有 publication@create（挂载=发布）；member 没有", async () => {
    expect(await canPublishAsset(ctxOf(uploader), prodId, privateAssetId, "create")).toBe(true);
    expect(await canPublishAsset(ctxOf(member), prodId, privateAssetId, "create")).toBe(false);
  });

  it("share 令牌：项目出口开着时——无 shares@create → 不允许；有票但无 file@view → 不可含下载", async () => {
    // #236：policy.share_token_enabled **默认关**（出口是全系统唯一把访问权发到权限
    // 系统之外的动作）。本例测的是**能力票规则**，与项目开关串联，故先把出口打开。
    await setPolicies(prodId, { "policy.share_token_enabled": POLICY_ON }, uploader);
    const noShare = await canCreateShareToken(ctxOf(member), prodId, { id: publicAssetId });
    expect(noShare.allowed).toBe(false);  // member 没有 shares@create

    const metaOnly = await newUser();
    await giveTicket(metaOnly, prodId, "meta", "view");
    await giveTicket(metaOnly, prodId, "shares", "create");
    const cap = await canCreateShareToken(ctxOf(metaOnly), prodId, { id: publicAssetId });
    expect(cap.allowed).toBe(true);
    expect(cap.downloadable).toBe(false);  // 不能分享自己没有的 file@view

    const full = await canCreateShareToken(ctxOf(uploader), prodId, { id: publicAssetId });
    expect(full.allowed).toBe(true);
    expect(full.downloadable).toBe(true);

    // 关掉出口 ⇒ 持全票的人也发不了（能力票 ∧ 项目开关，两者串联）
    await setPolicies(prodId, { "policy.share_token_enabled": POLICY_OFF }, uploader);
    const closed = await canCreateShareToken(ctxOf(uploader), prodId, { id: publicAssetId });
    expect(closed.allowed).toBe(false);
    expect(closed.downloadable).toBe(false);
  });
});

// 本块放文件末尾：给 member 发 script 票会改变后续挂载判定，不得污染前面的用例。
describe("挂载让渡（script 通道）与 node_mount CRUD", () => {
  it("block 挂载：宿主域票 ∧ 能力票才让渡；撤挂即收缩", async () => {
    const node = await getNodeByAssetId(privateAssetId);
    expect(node).not.toBeNull();
    const mount = await addNodeMount({
      nodeId: node!.id, productionId: prodId,
      mountType: "block", mountId: shortId(), createdBy: uploader,
    });

    // 挂上了，但 member 只有 asset 能力票、无 script blocks@view → 让渡不成立
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId }, "meta")).toBe(false);

    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'script', '*', 'blocks', 'view', 'auto')`,
      [prodId, member],
    );
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId }, "meta")).toBe(true);
    // 集合式同源不分叉
    const set = await filterVisibleAssets(ctxOf(member), prodId, [{ id: privateAssetId }]);
    expect(set.map(a => a.id)).toContain(privateAssetId);
    // 宿主域票不豁免能力票（outsider 无 asset 票）
    expect(await canViewAsset(ctxOf(outsider), prodId, { id: privateAssetId }, "meta")).toBe(false);

    // CRUD 读面
    expect((await getNodeMount(mount.id))?.mountType).toBe("block");
    expect((await listNodeMounts(node!.id)).map(m => m.id)).toContain(mount.id);

    // 撤挂 → 让渡收缩（解除挂载即收缩，不物化 grant 行）
    await removeNodeMount(mount.id);
    expect(await getNodeMount(mount.id)).toBeNull();
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId }, "meta")).toBe(false);
  });
});
