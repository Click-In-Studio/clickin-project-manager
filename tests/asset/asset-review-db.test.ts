import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAsset } from "@/lib/asset/db";
import { listPrivateAssets, setAssetPublic, revokeAssetGrant } from "@/lib/asset/review-db";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

// #550：数字资产审查页 500——review-db.ts 仍查 asset.is_public，该列已随 #420 迁入
// node.is_public。本文件之前没有任何用例覆盖 review-db.ts。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

async function giveInstanceGrant(userId: string, prodId: string, assetId: string): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'asset', $3, 'meta', 'view', 'direct')
     RETURNING id`,
    [prodId, userId, assetId],
  );
  return res.rows[0].id;
}

let prodId: string;
let uploader: string;
let viewer: string;
let privateAssetId: string;
let publicAssetId: string;
let viewerGrantId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [uploader, viewer] = await Promise.all([newUser(), newUser()]);

  privateAssetId = (await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "private.pdf", mimeType: "application/pdf",
    storageType: "r2", isPublic: false,
  })).asset.id;
  publicAssetId = (await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "public.pdf", mimeType: "application/pdf",
    storageType: "r2", isPublic: true,
  })).asset.id;

  viewerGrantId = await giveInstanceGrant(viewer, prodId, privateAssetId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("listPrivateAssets：is_public 取自 node", () => {
  it("只返回私有资产，且带上实例授权", async () => {
    const rows = await listPrivateAssets(prodId);
    expect(rows.map(r => r.id)).toEqual([privateAssetId]);
    const row = rows[0];
    expect(row.fileName).toBe("private.pdf");
    expect(row.uploaderId).toBe(uploader);
    expect(row.mountCount).toBe(0);
    // uploader 自己的创建者行集 + viewer 的一条手工授权都在（都是 resource_id=该资产的实例授权）
    expect(row.grants.some(g => g.grantId === viewerGrantId && g.userId === viewer)).toBe(true);
    expect(row.grants.every(g => g.userId === viewer || g.userId === uploader)).toBe(true);
  });

  it("没有壳节点的资产不出现（坏数据不假装存在）", async () => {
    // 手工直插 asset 行绕过 createAsset 的同事务建壳，制造线上「缺行」形态
    const orphanId = shortId();
    await getPool().query(
      `INSERT INTO asset (id, production_id, uploader_user_id, asset_type, file_name, mime_type, storage_type)
       VALUES ($1, $2, $3, 'reference', 'orphan.pdf', 'application/pdf', 'r2')`,
      [orphanId, prodId, uploader],
    );
    try {
      const rows = await listPrivateAssets(prodId);
      expect(rows.map(r => r.id)).not.toContain(orphanId);
      expect(await setAssetPublic(prodId, orphanId, true)).toBe(false);
    } finally {
      await getPool().query("DELETE FROM asset WHERE id = $1", [orphanId]);
    }
  });
});

describe("setAssetPublic：写 node.is_public", () => {
  it("切公开后列表为空；切回私有又出现", async () => {
    expect(await setAssetPublic(prodId, privateAssetId, true)).toBe(true);
    const nodeRow = await getPool().query<{ is_public: boolean }>(
      "SELECT is_public FROM node WHERE asset_id = $1", [privateAssetId]);
    expect(nodeRow.rows[0].is_public).toBe(true);
    expect(await listPrivateAssets(prodId)).toEqual([]);

    expect(await setAssetPublic(prodId, privateAssetId, false)).toBe(true);
    expect((await listPrivateAssets(prodId)).map(r => r.id)).toEqual([privateAssetId]);
  });

  it("不存在的资产 / 跨演出 → false", async () => {
    expect(await setAssetPublic(prodId, shortId(), true)).toBe(false);
    const { prodId: otherProd } = await makeProduction();
    try {
      expect(await setAssetPublic(otherProd, publicAssetId, false)).toBe(false);
      const still = await getPool().query<{ is_public: boolean }>(
        "SELECT is_public FROM node WHERE asset_id = $1", [publicAssetId]);
      expect(still.rows[0].is_public).toBe(true);
    } finally {
      await cleanupProduction(otherProd).catch(() => {});
    }
  });
});

describe("revokeAssetGrant", () => {
  it("撤销后从授权面消失；再撤 → not_found", async () => {
    expect(await revokeAssetGrant(prodId, viewerGrantId)).toBe("ok");
    const rows = await listPrivateAssets(prodId);
    expect(rows[0]?.grants.some(g => g.grantId === viewerGrantId)).toBe(false);
    expect(await revokeAssetGrant(prodId, viewerGrantId)).toBe("not_found");
  });

  it("非 asset 类授权 → wrong_type，且不动它", async () => {
    const res = await getPool().query<{ id: string }>(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'wiki', '*', 'meta', 'view', 'direct') RETURNING id`,
      [prodId, viewer],
    );
    const wikiGrantId = res.rows[0].id;
    expect(await revokeAssetGrant(prodId, wikiGrantId)).toBe("wrong_type");
    const still = await getPool().query<{ is_revoked: boolean }>(
      "SELECT is_revoked FROM production_member_grant WHERE id = $1", [wikiGrantId]);
    expect(still.rows[0].is_revoked).toBe(false);
  });
});
