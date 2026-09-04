// wiki 图片工程（commit 3）后端面：mount_type='wiki' 的可见性让渡 ——
// 文档可见 ⇒ 挂其上的图可见；单实例判定（canViewAsset）与列表过滤
// （filterVisibleAssets）必须同语义（批D 教训：分叉即「列表看得见、点进去 403」）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAsset } from "@/lib/asset/db";
import { addAssetMount } from "@/lib/asset/mount";
import { canViewAsset, filterVisibleAssets, mountHostSidePermitted } from "@/lib/asset/perm";
import type { PermissionContext } from "@/lib/permissions";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction } from "./factories";

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

async function giveAssetTicket(userId: string, prodId: string, sub: string, verb: string) {
  await getPool().query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'asset', '*', $3, $4, 'auto')
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false DO NOTHING`,
    [prodId, userId, sub, verb],
  );
}

let prodId: string;
let uploader: string;
let reader: string;        // asset 能力票 + wiki 个人行 → 经挂载可见
let ticketOnly: string;    // asset 能力票，但 wiki 不可见 → 挂载不让渡
let mountedAssetId: string;
let wikiId: string;
let hiddenWikiId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [uploader, reader, ticketOnly] = await Promise.all([newUser(), newUser(), newUser()]);

  const pool = getPool();
  const w = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by, is_public)
     VALUES ($1, '图床测试文档', '', $2, false) RETURNING id::text AS id`,
    [prodId, uploader],
  );
  wikiId = w.rows[0].id;
  const hw = await pool.query<{ id: string }>(
    `INSERT INTO wiki (production_id, title, body, created_by, is_public)
     VALUES ($1, '无人可见文档', '', $2, false) RETURNING id::text AS id`,
    [prodId, uploader],
  );
  hiddenWikiId = hw.rows[0].id;

  const a = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "pasted.png", mimeType: "image/png",
    storageType: "r2", isPublic: false,
  });
  mountedAssetId = a.asset.id;
  await addAssetMount({
    assetId: mountedAssetId, productionId: prodId,
    mountType: "wiki", mountId: wikiId, createdBy: uploader,
  });

  // 两人都有 asset 能力票；只有 reader 拿到 wiki 的个人可见行
  await giveAssetTicket(reader, prodId, "meta", "view");
  await giveAssetTicket(ticketOnly, prodId, "meta", "view");
  await pool.query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'wiki', $3, '*', 'view', 'auto')`,
    [prodId, reader, wikiId],
  );
  // 直接 SQL 建的 wiki 没有创建者行集（那由 wiki POST 路由写）——给 uploader 补
  // 编辑行，代表「文档编辑者」角色做宿主侧门测试
  await pool.query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'wiki', $3, '*', 'edit', 'auto')`,
    [prodId, uploader, wikiId],
  );
});

afterAll(async () => {
  await getPool().query("DELETE FROM wiki WHERE production_id = $1", [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("wiki 挂载边可见性让渡", () => {
  it("文档可见 + 能力票 → 图可见（canViewAsset）", async () => {
    expect(await canViewAsset(ctxOf(reader), prodId, { id: mountedAssetId, isPublic: false }, "meta")).toBe(true);
  });

  it("文档不可见 → 挂载不让渡（能力票单独不够）", async () => {
    expect(await canViewAsset(ctxOf(ticketOnly), prodId, { id: mountedAssetId, isPublic: false }, "meta")).toBe(false);
  });

  it("列表过滤与单实例判定同语义", async () => {
    const assets = [{ id: mountedAssetId, isPublic: false }];
    const forReader = await filterVisibleAssets(ctxOf(reader), prodId, assets);
    const forTicketOnly = await filterVisibleAssets(ctxOf(ticketOnly), prodId, assets);
    expect(forReader.map(a => a.id)).toEqual([mountedAssetId]);
    expect(forTicketOnly).toEqual([]);
  });

  it("宿主侧门：挂载进文档 = 编辑该文档（无编辑权者被拒）", async () => {
    // reader 只有 view 行，没有 wiki 编辑权 → 不允许把图挂进文档
    expect(await mountHostSidePermitted(ctxOf(reader), prodId, "wiki", wikiId)).toBe(false);
    // uploader 持该文档 *@edit 行 → 允许
    expect(await mountHostSidePermitted(ctxOf(uploader), prodId, "wiki", wikiId)).toBe(true);
  });

  it("挂在别的（不可见）文档上不产生越权让渡", async () => {
    const b = await createAsset({
      productionId: prodId, uploaderUserId: uploader, assetType: "reference",
      fileName: "hidden.png", mimeType: "image/png",
      storageType: "r2", isPublic: false,
    });
    await addAssetMount({
      assetId: b.asset.id, productionId: prodId,
      mountType: "wiki", mountId: hiddenWikiId, createdBy: uploader,
    });
    expect(await canViewAsset(ctxOf(reader), prodId, { id: b.asset.id, isPublic: false }, "meta")).toBe(false);
    const filtered = await filterVisibleAssets(ctxOf(reader), prodId, [{ id: b.asset.id, isPublic: false }]);
    expect(filtered).toEqual([]);
  });
});
