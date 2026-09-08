// #457 relay-part 的门：中继写的是和 presign-part 同一批字节，门此前却查的是
// script/*/blocks@view（剧本台词的**查看**权）——与 presign 家族三条路由完全不同源，
// 且不认 assetId，#456 的「传新版本」门在中继路径上是漏的。
//
// 这个洞此前只在 ≥50MB + R2 直连不通时可达；#457 让 <50MB 的文件也能降级走中继后，
// 可达面显著扩大，故同批收敛。这里守的是收敛后的契约：
//   · 门 = canUploadAssetBytes，按 assetId 分叉（同 presign / presign-part / presign-multipart）
//   · 只有剧本查看权 ≠ 能中继上传（收紧方向的回归证人）
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createAsset } from "@/lib/asset/db";
import { POST as relayPOST } from "@/app/api/production/[id]/assets/relay-part/route";
import { makeProduction, cleanupProduction } from "./factories";

const { relayMock } = vi.hoisted(() => ({ relayMock: vi.fn() }));
vi.mock("@/lib/r2", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/r2")>(),
  uploadPartRelay: relayMock,
}));

beforeEach(() => { relayMock.mockReset().mockResolvedValue("etag-1"); });

let prodId: string;
let uploader: string;    // 创建者行集（含 file@create），无通配 create
let wildcard: string;    // 持资产域通配 create
let scriptOnly: string;  // 只有 script/*/blocks@view —— 旧门放行、新门必须挡
let stranger: string;    // 成员，无任何 asset 授权
let outsider: string;    // 非成员
let assetId: string;

const cookieFor = (userId: string) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;

async function newMember(pid: string | null): Promise<string> {
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const userId = u.rows[0].id;
  if (pid) {
    await getPool().query(
      `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
      [pid, userId],
    );
  }
  return userId;
}

async function grant(
  userId: string, type: string, resId: string, sub: string, level: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, $3, $4, $5, $6, 'auto')
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false DO NOTHING`,
    [prodId, userId, type, resId, sub, level],
  );
}

/** 中继一个 part。assetId 省略＝新建资产的形态（门＝通配 create）。 */
function relayReq(userId: string, opts: { assetId?: string; bytes?: number } = {}): NextRequest {
  const qs = new URLSearchParams({
    r2Key: "assets/t457_v1/x.pdf", uploadId: "up-1", partNumber: "1",
  });
  if (opts.assetId) qs.set("assetId", opts.assetId);
  return new NextRequest(`http://localhost/api/relay-part?${qs}`, {
    method: "POST",
    headers: { Cookie: cookieFor(userId), "Content-Type": "application/octet-stream" },
    body: new Uint8Array(opts.bytes ?? 8),
  });
}

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  uploader   = await newMember(prodId);
  wildcard   = await newMember(prodId);
  scriptOnly = await newMember(prodId);
  stranger   = await newMember(prodId);
  outsider   = await newMember(null);

  const created = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "设计图.pdf", mimeType: "application/pdf",
    storageType: "r2", r2Key: "assets/t457_v0/design.pdf", fileSize: 1000,
  });
  assetId = created.asset.id;

  await grant(wildcard, "asset", "*", "*", "create");
  // 旧门恰好认这一枚——它是本次收敛的证人
  await grant(scriptOnly, "script", "*", "blocks", "view");
});

afterAll(async () => {
  await getPool().query(`DELETE FROM job WHERE payload->>'r2Key' LIKE 'assets/t457_%'`).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("relay-part 的门（#457）", () => {
  it("未登录 401；非成员 403", async () => {
    const noCookie = new NextRequest(
      "http://localhost/api/relay-part?r2Key=a&uploadId=b&partNumber=1",
      { method: "POST" });
    expect((await relayPOST(noCookie, ctx())).status).toBe(401);
    expect((await relayPOST(relayReq(outsider), ctx())).status).toBe(403);
  });

  it("只有 script/*/blocks@view 的成员 → 403（旧门会放行，这是收敛的证人）", async () => {
    expect((await relayPOST(relayReq(scriptOnly), ctx())).status).toBe(403);
    expect((await relayPOST(relayReq(scriptOnly, { assetId }), ctx())).status).toBe(403);
    expect(relayMock).not.toHaveBeenCalled();
  });

  it("无票成员两种目标都 403", async () => {
    expect((await relayPOST(relayReq(stranger), ctx())).status).toBe(403);
    expect((await relayPOST(relayReq(stranger, { assetId }), ctx())).status).toBe(403);
  });

  it("门按 assetId 分叉：只有创建者行集时带目标放行、不带目标 403", async () => {
    // 与 presign / presign-part / presign-multipart 完全同源
    expect((await relayPOST(relayReq(uploader, { assetId }), ctx())).status).toBe(200);
    expect((await relayPOST(relayReq(uploader), ctx())).status).toBe(403);
  });

  it("持通配 create：两种目标都放行", async () => {
    expect((await relayPOST(relayReq(wildcard), ctx())).status).toBe(200);
    expect((await relayPOST(relayReq(wildcard, { assetId }), ctx())).status).toBe(200);
  });

  it("放行后才真的写 R2，且透传 r2Key/uploadId/partNumber", async () => {
    const res = await relayPOST(relayReq(wildcard, { assetId, bytes: 16 }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eTag: "etag-1" });
    expect(relayMock).toHaveBeenCalledTimes(1);
    const [key, upId, partNo, buf] = relayMock.mock.calls[0];
    expect(key).toBe("assets/t457_v1/x.pdf");
    expect(upId).toBe("up-1");
    expect(partNo).toBe(1);
    expect((buf as ArrayBuffer).byteLength).toBe(16);
  });

  it("参数缺失 → 400（在门之前，不泄露权限信息）", async () => {
    const bad = new NextRequest("http://localhost/api/relay-part?r2Key=a&uploadId=b", {
      method: "POST", headers: { Cookie: cookieFor(wildcard) },
    });
    expect((await relayPOST(bad, ctx())).status).toBe(400);
  });
});
