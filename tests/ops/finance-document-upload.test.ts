import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { getPool } from "@/lib/pg";
import { listAssets } from "@/lib/asset/db";
import { listEnumerableNodeIds } from "@/lib/node/perm";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

vi.mock("@/lib/r2", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/r2")>(),
  presignedPut: vi.fn(() => ({ url: "https://r2.example/put", contentType: "application/pdf" })),
}));
vi.mock("@/lib/job/asset-jobs", () => ({ enqueueAssetPostProcess: vi.fn(async () => {}) }));

import { POST as createAssetRoute } from "@/app/api/production/[id]/assets/route";
import { POST as presignRoute } from "@/app/api/production/[id]/assets/presign/route";
import {
  DELETE as deleteAssetRoute,
  GET as getAssetRoute,
  PATCH as patchAssetRoute,
} from "@/app/api/production/[id]/assets/[assetId]/route";
import { GET as downloadAssetRoute } from "@/app/api/production/[id]/assets/[assetId]/download-url/route";
import { GET as previewAssetRoute } from "@/app/api/production/[id]/assets/[assetId]/preview-url/route";

let prodId: string;
let ownerId: string;
let financeOnlyId: string;
let outsiderId: string;

function request(userId: string | null, body: unknown) {
  const req = new NextRequest("http://localhost/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (userId) req.cookies.set(SESSION_COOKIE, createSession({
    userId, name: "测试", avatarUrl: null, isAdmin: false,
  }));
  return req;
}

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });
const assetCtx = (assetId: string) => ({ params: Promise.resolve({ id: prodId, assetId }) });

function assetRequest(userId: string, method: "GET" | "PATCH" | "DELETE", body?: unknown) {
  const req = new NextRequest("http://localhost/api/assets/id", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  req.cookies.set(SESSION_COOKIE, createSession({
    userId, name: "测试", avatarUrl: null, isAdmin: false,
  }));
  return req;
}

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  ownerId = (await getPool().query<{ owner_id: string }>(
    "SELECT owner_id FROM production WHERE id = $1", [prodId],
  )).rows[0].owner_id;
  financeOnlyId = (await getPool().query<{ id: string }>(
    "INSERT INTO app_user DEFAULT VALUES RETURNING id",
  )).rows[0].id;
  outsiderId = (await getPool().query<{ id: string }>(
    "INSERT INTO app_user DEFAULT VALUES RETURNING id",
  )).rows[0].id;
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, financeOnlyId],
  );
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'finance', '*', 'expenses', 'create', 'auto')`,
    [prodId, financeOnlyId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("财务凭证上传用途", () => {
  const uploadBody = (purpose?: string) => ({
    storageType: "r2",
    r2Key: `assets/af_${shortId()}/invoice.pdf`,
    fileId: `af_${shortId()}`,
    fileName: "invoice.pdf",
    mimeType: "application/pdf",
    assetType: "reference",
    ...(purpose ? { purpose } : {}),
  });

  it("未登录是 401，非成员是 403", async () => {
    expect((await createAssetRoute(request(null, uploadBody("expense_document")), ctx())).status).toBe(401);
    expect((await createAssetRoute(request(outsiderId, uploadBody("expense_document")), ctx())).status).toBe(403);
  });

  it("只持 expenses@create 可以上传票据，但不能借此创建普通资产", async () => {
    const presign = await presignRoute(request(financeOnlyId, {
      fileName: "invoice.pdf", mimeType: "application/pdf", purpose: "expense_document",
    }), ctx());
    expect(presign.status).toBe(200);

    const normalPresign = await presignRoute(request(financeOnlyId, {
      fileName: "reference.pdf", mimeType: "application/pdf",
    }), ctx());
    expect(normalPresign.status).toBe(403);
  });

  it("注册结果固定为 private single-file 财务凭证，且不发行通用 asset grant", async () => {
    const response = await createAssetRoute(
      request(financeOnlyId, uploadBody("expense_document")), ctx(),
    );
    expect(response.status).toBe(201);
    const body = await response.json() as { asset: { id: string; assetType: string; fileVersionPolicy: string } };
    expect(body.asset).toMatchObject({
      assetType: "financial_document",
      fileVersionPolicy: "single",
    });

    const { rows: [node] } = await getPool().query<{ listable: boolean; created_by: string | null }>(
      "SELECT listable, created_by FROM node WHERE asset_id = $1", [body.asset.id],
    );
    expect(node.listable).toBe(false);
    expect(node.created_by).toBeNull();
    const enumerable = await listEnumerableNodeIds(
      { userId: financeOnlyId, isAdmin: false, isOwner: false }, prodId,
    );
    const assetNode = await getPool().query<{ id: string }>(
      "SELECT id FROM node WHERE asset_id = $1", [body.asset.id],
    );
    expect(enumerable.ids.has(assetNode.rows[0].id)).toBe(false);
    const { rows: [{ count }] } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM production_member_grant
        WHERE production_id = $1 AND resource_type = 'asset' AND resource_id = $2 AND NOT is_revoked`,
      [prodId, body.asset.id],
    );
    expect(count).toBe("0");
    expect((await listAssets(prodId)).map(asset => asset.id)).not.toContain(body.asset.id);

    const routeCtx = assetCtx(body.asset.id);
    expect((await getAssetRoute(assetRequest(ownerId, "GET"), routeCtx)).status).toBe(403);
    expect((await patchAssetRoute(assetRequest(ownerId, "PATCH", { name: "改名" }), routeCtx)).status).toBe(403);
    expect((await deleteAssetRoute(assetRequest(ownerId, "DELETE"), routeCtx)).status).toBe(403);
    expect((await downloadAssetRoute(assetRequest(ownerId, "GET"), routeCtx)).status).toBe(403);
    expect((await previewAssetRoute(assetRequest(ownerId, "GET"), routeCtx)).status).toBe(403);
  });

  it("通用上传入口不能伪造 financial_document 类型", async () => {
    const response = await createAssetRoute(request(ownerId, {
      ...uploadBody(), assetType: "financial_document",
    }), ctx());
    expect(response.status).toBe(400);
  });
});
