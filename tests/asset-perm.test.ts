import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAsset } from "@/lib/asset-db";
import { canViewAsset, filterVisibleAssets, canPublishAsset, canCreateShareToken } from "@/lib/asset-perm";
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
    `INSERT INTO resource_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
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
    isUniversal: true, storageType: "r2", isPublic: false,
  });
  privateAssetId = priv.asset.id;
  const pub = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "public.pdf", mimeType: "application/pdf",
    isUniversal: true, storageType: "r2", isPublic: true,
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
    expect(await canViewAsset(ctxOf(member), prodId, { id: publicAssetId, isPublic: true }, "meta")).toBe(true);
  });

  it("能力票单独不越隐私（未挂载私有 → 不可见）", async () => {
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId, isPublic: false }, "meta")).toBe(false);
  });

  it("无能力票即使公开也不可见", async () => {
    expect(await canViewAsset(ctxOf(outsider), prodId, { id: publicAssetId, isPublic: true }, "meta")).toBe(false);
  });

  it("publication@view 显式通配越隐私（无需能力票的 file 面也可）", async () => {
    expect(await canViewAsset(ctxOf(librarian), prodId, { id: privateAssetId, isPublic: false }, "file")).toBe(true);
  });

  it("创建者行集：uploader 自见隐私资产（实例 publication@view）", async () => {
    expect(await canViewAsset(ctxOf(uploader), prodId, { id: privateAssetId, isPublic: false }, "meta")).toBe(true);
  });
});

describe("挂载让渡（production 根共享区）", () => {
  it("挂载后能力票持有者可见；解除后回到隐私", async () => {
    const mid = `am${shortId()}`;
    await getPool().query(
      `INSERT INTO asset_mount (id, asset_id, production_id, mount_type, mount_id, created_by)
       VALUES ($1, $2, $3, 'production', $3, $4)`,
      [mid, privateAssetId, prodId, uploader],
    );
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId, isPublic: false }, "meta")).toBe(true);
    // 无能力票者依然不可见（让渡不豁免能力票）
    expect(await canViewAsset(ctxOf(outsider), prodId, { id: privateAssetId, isPublic: false }, "meta")).toBe(false);

    await getPool().query("DELETE FROM asset_mount WHERE id = $1", [mid]);
    expect(await canViewAsset(ctxOf(member), prodId, { id: privateAssetId, isPublic: false }, "meta")).toBe(false);
  });
});

describe("filterVisibleAssets 集合式一致性", () => {
  it("member 看到公开不看到隐私；librarian 全见", async () => {
    const assets = [
      { id: privateAssetId, isPublic: false },
      { id: publicAssetId, isPublic: true },
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

  it("share 令牌：无 shares@create → 不允许；有票但无 file@view → 不可含下载", async () => {
    const noShare = await canCreateShareToken(ctxOf(member), prodId, { id: publicAssetId, isPublic: true });
    expect(noShare.allowed).toBe(false);  // member 没有 shares@create

    const metaOnly = await newUser();
    await giveTicket(metaOnly, prodId, "meta", "view");
    await giveTicket(metaOnly, prodId, "shares", "create");
    const cap = await canCreateShareToken(ctxOf(metaOnly), prodId, { id: publicAssetId, isPublic: true });
    expect(cap.allowed).toBe(true);
    expect(cap.downloadable).toBe(false);  // 不能分享自己没有的 file@view

    const full = await canCreateShareToken(ctxOf(uploader), prodId, { id: publicAssetId, isPublic: true });
    expect(full.allowed).toBe(true);
    expect(full.downloadable).toBe(true);
  });
});
