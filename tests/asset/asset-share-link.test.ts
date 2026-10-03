import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createAsset } from "@/lib/asset/db";
import {
  createAssetShareLink,
  getAssetShareLinkAccess,
  listAssetShareLinks,
  redeemOneTimeAssetShareLink,
  revokeAssetShareLink,
} from "@/lib/asset/share-link-db";
import { getPool } from "@/lib/pg";
import { setPolicies } from "@/lib/perm/policy-db";
import { POLICY_OFF, POLICY_ON } from "@/lib/perm/policy-keys";
import { GET as manageGET, POST as managePOST } from "@/app/api/production/[id]/assets/[assetId]/share/route";
import { DELETE as manageDELETE } from "@/app/api/production/[id]/assets/[assetId]/share/[linkId]/route";
import { GET as assetsGET } from "@/app/api/production/[id]/assets/route";
import { GET as publicGET } from "@/app/api/share/[token]/route";
import { GET as streamGET } from "@/app/api/share/[token]/stream/route";
import { POST as redeemPOST } from "@/app/api/share/[token]/redeem/route";
import { cleanupProduction, makeProduction } from "../_support/factories";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("@/lib/r2", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/r2")>(),
  getR2Stream: streamMock,
}));

async function newUser(): Promise<string> {
  const result = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return result.rows[0].id;
}

function cookieFor(userId: string): string {
  return `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
}

function manageReq(method: string, userId: string | null, body?: unknown): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userId) headers.Cookie = cookieFor(userId);
  return new NextRequest(`http://localhost/api/production/${prodId}/assets/${assetId}/share`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let prodId: string;
let ownerId: string;
let outsiderId: string;
let singleKeyId: string;
let managerId: string;
let assetId: string;

const manageCtx = () => ({ params: Promise.resolve({ id: prodId, assetId }) });

beforeAll(async () => {
  [ownerId, outsiderId, singleKeyId, managerId] = await Promise.all([
    newUser(), newUser(), newUser(), newUser(),
  ]);
  ({ prodId } = await makeProduction(ownerId));
  await getPool().query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')",
    [prodId, singleKeyId],
  );
  await getPool().query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')",
    [prodId, managerId],
  );
  const created = await createAsset({
    productionId: prodId,
    uploaderUserId: ownerId,
    assetType: "reference",
    fileName: "分享文件.pdf",
    mimeType: "application/pdf",
    storageType: "r2",
    r2Key: "assets/test/____.pdf",
    isPublic: false,
  });
  assetId = created.asset.id;
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'asset', $3, 'shares', 'create', 'auto')`,
    [prodId, singleKeyId, assetId],
  );
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'asset', $3, '*', 'view', 'direct'),
            ($1, $2, 'asset', $3, 'grants', 'edit', 'direct')`,
    [prodId, managerId, assetId],
  );
  await setPolicies(prodId, { "policy.share_token_enabled": POLICY_ON }, ownerId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query(
    "DELETE FROM app_user WHERE id = ANY($1)", [[ownerId, outsiderId, singleKeyId, managerId]],
  ).catch(() => {});
});

describe("分享链接数据状态机", () => {
  it("普通链接可反复兑现，撤销后立即失效", async () => {
    const link = await createAssetShareLink({
      productionId: prodId, assetId, createdBy: ownerId,
      expiresInDays: 7, allowDownload: false, oneTime: false,
    });
    expect((await getAssetShareLinkAccess(link.token)).kind).toBe("valid");
    expect((await getAssetShareLinkAccess(link.token)).kind).toBe("valid");
    expect(await revokeAssetShareLink(prodId, assetId, link.id)).toBe(true);
    expect((await getAssetShareLinkAccess(link.token)).kind).toBe("invalid");
  });

  it("单次链接并发兑换只有一个成功，且只认兑换浏览器的秘密", async () => {
    const link = await createAssetShareLink({
      productionId: prodId, assetId, createdBy: ownerId,
      expiresInDays: 7, allowDownload: true, oneTime: true,
    });
    expect((await getAssetShareLinkAccess(link.token)).kind).toBe("requires_redemption");

    const results = await Promise.all([
      redeemOneTimeAssetShareLink(link.token),
      redeemOneTimeAssetShareLink(link.token),
    ]);
    expect(results.map(result => result.kind).sort()).toEqual(["already_redeemed", "redeemed"]);
    const redeemed = results.find(result => result.kind === "redeemed");
    expect(redeemed?.kind).toBe("redeemed");
    if (!redeemed || redeemed.kind !== "redeemed") throw new Error("兑换结果缺失");

    expect((await getAssetShareLinkAccess(link.token)).kind).toBe("invalid");
    expect((await getAssetShareLinkAccess(link.token, "wrong-secret")).kind).toBe("invalid");
    expect((await getAssetShareLinkAccess(link.token, redeemed.sessionSecret)).kind).toBe("valid");

    await getPool().query(
      "UPDATE asset_share_link SET session_last_seen_at = now() - interval '31 minutes' WHERE id = $1",
      [link.id],
    );
    expect((await getAssetShareLinkAccess(link.token, redeemed.sessionSecret)).kind).toBe("invalid");
  });
});

describe("分享链接下载文件名", () => {
  it("允许下载时用 RFC 5987 返回中文文件名", async () => {
    const link = await createAssetShareLink({
      productionId: prodId, assetId, createdBy: ownerId,
      expiresInDays: 7, allowDownload: true, oneTime: false,
    });
    streamMock.mockResolvedValueOnce(new Response("pdf", {
      headers: { "content-type": "application/pdf", "content-length": "3" },
    }));

    const response = await streamGET(
      new NextRequest(`http://localhost/api/share/${link.token}/stream`),
      { params: Promise.resolve({ token: link.token }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"____.pdf\"; filename*=UTF-8''%E5%88%86%E4%BA%AB%E6%96%87%E4%BB%B6.pdf",
    );
  });
});

describe("分享管理路由权限与闭环", () => {
  it("资产列表动作与分享链接后端门禁一致", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'asset', $3, '*', 'view', 'direct')`,
      [prodId, singleKeyId, assetId],
    );
    try {
      const createOnly = await assetsGET(manageReq("GET", singleKeyId), {
        params: Promise.resolve({ id: prodId }),
      });
      expect(createOnly.status).toBe(200);
      const createOnlyBody = await createOnly.json() as {
        assets: { id: string; actions: { externalShare: boolean; externalShareCreate: boolean } }[];
      };
      expect(createOnlyBody.assets.find(asset => asset.id === assetId)?.actions).toMatchObject({
        externalShare: false,
        externalShareCreate: false,
      });

      const manager = await assetsGET(manageReq("GET", managerId), {
        params: Promise.resolve({ id: prodId }),
      });
      expect(manager.status).toBe(200);
      const managerBody = await manager.json() as typeof createOnlyBody;
      expect(managerBody.assets.find(asset => asset.id === assetId)?.actions).toMatchObject({
        externalShare: true,
        externalShareCreate: false,
      });
    } finally {
      await getPool().query(
        `DELETE FROM production_member_grant
         WHERE production_id = $1 AND user_id = $2 AND resource_type = 'asset'
           AND resource_id = $3 AND resource_sub = '*' AND permission_level = 'view'`,
        [prodId, singleKeyId, assetId],
      );
    }
  });

  it("未登录 401、非成员 403、只持 shares@create 单枚键仍 403", async () => {
    expect((await managePOST(manageReq("POST", null, {}), manageCtx())).status).toBe(401);
    expect((await managePOST(manageReq("POST", outsiderId, {}), manageCtx())).status).toBe(403);
    expect((await managePOST(manageReq("POST", singleKeyId, {}), manageCtx())).status).toBe(403);

    expect((await manageGET(manageReq("GET", null), manageCtx())).status).toBe(401);
    expect((await manageGET(manageReq("GET", outsiderId), manageCtx())).status).toBe(403);
    expect((await manageGET(manageReq("GET", singleKeyId), manageCtx())).status).toBe(403);

    const deleteCtx = { params: Promise.resolve({ id: prodId, assetId, linkId: "asl_missing" }) };
    expect((await manageDELETE(manageReq("DELETE", null), deleteCtx)).status).toBe(401);
    expect((await manageDELETE(manageReq("DELETE", outsiderId), deleteCtx)).status).toBe(403);
    expect((await manageDELETE(manageReq("DELETE", singleKeyId), deleteCtx)).status).toBe(403);
  });

  it("资产管理者可列出和撤销链接，但没有外发资格时不能创建", async () => {
    expect((await manageGET(manageReq("GET", managerId), manageCtx())).status).toBe(200);
    expect((await managePOST(manageReq("POST", managerId, {}), manageCtx())).status).toBe(403);
    const missing = await manageDELETE(
      manageReq("DELETE", managerId),
      { params: Promise.resolve({ id: prodId, assetId, linkId: "asl_missing" }) },
    );
    expect(missing.status).toBe(404);

    await getPool().query(
      `INSERT INTO production_member_grant
        (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
       VALUES ($1,$2,'asset',$3,'shares','create','direct')`,
      [prodId, managerId, assetId],
    );
    expect((await managePOST(manageReq("POST", managerId, {}), manageCtx())).status).toBe(201);
  });

  it("创建、列出与撤销走同一个有状态链接", async () => {
    const createdResponse = await managePOST(
      manageReq("POST", ownerId, {
        expiresInDays: 30, allowDownload: true, oneTime: false, note: "发给剧场",
      }),
      manageCtx(),
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { link: { id: string; token: string; note: string } };
    expect(created.link.note).toBe("发给剧场");

    const listResponse = await manageGET(manageReq("GET", ownerId), manageCtx());
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as { links: { id: string }[] };
    expect(listed.links.map(link => link.id)).toContain(created.link.id);

    // 归档只冻结新增写入，不得锁死安全收口；旧链接仍可列出并逐条撤销。
    await getPool().query("UPDATE production SET archived_at = now() WHERE id = $1", [prodId]);
    try {
      const listedWhileArchived = await manageGET(manageReq("GET", ownerId), manageCtx());
      expect(listedWhileArchived.status).toBe(200);
      const deleted = await manageDELETE(
        manageReq("DELETE", ownerId),
        { params: Promise.resolve({ id: prodId, assetId, linkId: created.link.id }) },
      );
      expect(deleted.status).toBe(200);
    } finally {
      await getPool().query("UPDATE production SET archived_at = NULL WHERE id = $1", [prodId]);
    }
    expect((await getAssetShareLinkAccess(created.link.token)).kind).toBe("invalid");
  });
});

describe("单次访问 HTTP 兑换", () => {
  it("GET 只展示兑换页不消耗；POST 后 cookie 可读取，另一浏览器不可读取", async () => {
    const link = await createAssetShareLink({
      productionId: prodId, assetId, createdBy: ownerId,
      expiresInDays: 7, allowDownload: false, oneTime: true,
    });
    const ctx = { params: Promise.resolve({ token: link.token }) };
    const url = `http://localhost/api/share/${link.token}`;

    const landing = await publicGET(new NextRequest(url), ctx);
    expect(landing.status).toBe(200);
    expect(await landing.json()).toEqual({ requiresRedemption: true });
    expect((await listAssetShareLinks(prodId, assetId)).find(row => row.id === link.id)?.redeemedAt).toBeNull();

    const redeemed = await redeemPOST(new NextRequest(`${url}/redeem`, { method: "POST" }), ctx);
    expect(redeemed.status).toBe(200);
    const sessionCookie = redeemed.headers.get("set-cookie")?.split(";", 1)[0];
    expect(sessionCookie).toMatch(/^asset_share_session=/);

    const opened = await publicGET(new NextRequest(url, { headers: { Cookie: sessionCookie! } }), ctx);
    expect(opened.status).toBe(200);
    expect((await opened.json()).oneTime).toBe(true);

    await getPool().query(
      "UPDATE asset_share_link SET session_last_seen_at = now() - interval '10 minutes' WHERE id = $1",
      [link.id],
    );
    const beforeOff = await listAssetShareLinks(prodId, assetId);
    const lastSeenBeforeOff = beforeOff.find(row => row.id === link.id)!.sessionLastSeenAt!.getTime();
    await setPolicies(prodId, { "policy.share_token_enabled": POLICY_OFF }, ownerId);
    try {
      const closed = await publicGET(new NextRequest(url, { headers: { Cookie: sessionCookie! } }), ctx);
      expect(closed.status).toBe(404);
      const whileOff = await listAssetShareLinks(prodId, assetId);
      expect(whileOff.find(row => row.id === link.id)!.sessionLastSeenAt!.getTime()).toBe(lastSeenBeforeOff);
    } finally {
      await setPolicies(prodId, { "policy.share_token_enabled": POLICY_ON }, ownerId);
    }

    const otherBrowser = await publicGET(new NextRequest(url), ctx);
    expect(otherBrowser.status).toBe(404);
  });
});
