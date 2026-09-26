import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createAsset } from "@/lib/asset/db";
import { canViewAsset } from "@/lib/asset/perm";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getPool } from "@/lib/pg";
import { GET, PUT } from "@/app/api/production/[id]/assets/[assetId]/access/route";
import { makeProduction, cleanupProduction } from "../_support/factories";

let prodId: string;
let assetId: string;
let member: string;
let outsider: string;
let recipient: string;

function request(userId?: string, method = "GET", body?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  if (userId) headers.Cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
  if (body) headers["Content-Type"] = "application/json";
  return new NextRequest(`http://localhost/api/production/${prodId}/assets/${assetId}/access`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}
const ctx = () => ({ params: Promise.resolve({ id: prodId, assetId }) });

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const users = await getPool().query<{ id: string }>(
    "INSERT INTO app_user (id) VALUES (gen_random_uuid()), (gen_random_uuid()), (gen_random_uuid()) RETURNING id");
  [member, outsider, recipient] = users.rows.map(r => r.id);
  await getPool().query(
    "INSERT INTO production_member (production_id,user_id,roles) VALUES ($1,$2,'{}'),($1,$3,'{}')",
    [prodId, member, recipient]);
  assetId = (await createAsset({
    productionId: prodId, uploaderUserId: member, assetType: "reference",
    fileName: "门测试.pdf", mimeType: "application/pdf", storageType: "r2",
  })).asset.id;
});

afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });

describe("资产站内分享路由", () => {
  it("匿名 401、非成员 403", async () => {
    expect((await GET(request(), ctx())).status).toBe(401);
    expect((await PUT(request(), ctx())).status).toBe(401);
    expect((await GET(request(outsider), ctx())).status).toBe(403);
    expect((await PUT(request(outsider), ctx())).status).toBe(403);
  });

  it("上传者可分享阅读；移除时保留收件人的其他直接授权", async () => {
    expect((await GET(request(member), ctx())).status).toBe(200);
    const add = await PUT(request(member, "PUT", {
      addPerson: { userId: recipient, canDownload: false },
    }), ctx());
    expect(add.status).toBe(200);
    const shared = await GET(request(member), ctx());
    expect((await shared.json()).people).toContainEqual({ userId: recipient, canDownload: false, removable: true });
    const recipientAccess = await getProductionPermissionContext(recipient, false, prodId);
    expect(await canViewAsset(recipientAccess!.permCtx, prodId, { id: assetId }, "meta")).toBe(true);
    expect(await canViewAsset(recipientAccess!.permCtx, prodId, { id: assetId }, "file")).toBe(false);
    await getPool().query(
      `INSERT INTO production_member_grant
       (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
       VALUES ($1,$2,'asset',$3,'meta','edit','direct')`, [prodId, recipient, assetId],
    );
    expect((await PUT(request(member, "PUT", { removePersonUserId: recipient }), ctx())).status).toBe(200);
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub,permission_level FROM production_member_grant
       WHERE production_id=$1 AND user_id=$2 AND resource_id=$3 AND NOT is_revoked`,
      [prodId, recipient, assetId],
    );
    expect(rows).toEqual([{ resource_sub: "meta", permission_level: "edit" }]);
  });

  it("只持读取单键不得管理分享", async () => {
    await getPool().query(
      `UPDATE production_member_grant SET is_revoked=true,revoked_reason='manual'
       WHERE production_id=$1 AND user_id=$2 AND resource_id=$3 AND resource_sub='grants'`,
      [prodId, member, assetId],
    );
    await getPool().query(
      `INSERT INTO production_member_grant
       (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
       VALUES ($1,$2,'asset',$3,'*','view','direct')`, [prodId, member, assetId],
    );
    expect((await GET(request(member), ctx())).status).toBe(403);
    expect((await PUT(request(member, "PUT", { isPublic: true }), ctx())).status).toBe(403);
  });
});
