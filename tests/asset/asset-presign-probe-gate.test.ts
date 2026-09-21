// #605 presign-probe 的门：探针拿的是 R2 直传预签名（测直传是否可达），此前却查的是
// script/*/blocks@view（剧本台词的查看权）——#457 收敛 relay-part 时漏了这条。
// 后果：持上传资格但没剧本读权的成员探针 403 → 前端跳过测速走保守路径；反过来只有
// 剧本读权的成员却能拿到写 R2 的预签名。这里守的是收敛后的契约：
//   · 门 = canUploadAssetBytes(permCtx, id, null)，与 presign / relay-part 同源
//   · 探针无 assetId，按通配 asset/*/*@create 判；创建者行集（file@create）不够
//   · 只有剧本查看权 ≠ 能探针（收紧方向的回归证人）
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createAsset } from "@/lib/asset/db";
import { GET as probeGET } from "@/app/api/production/[id]/assets/presign-probe/route";
import { makeProduction, cleanupProduction } from "../_support/factories";

const { presignMock } = vi.hoisted(() => ({ presignMock: vi.fn() }));
vi.mock("@/lib/r2", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/r2")>(),
  presignedPut: presignMock,
}));

beforeEach(() => {
  presignMock.mockReset().mockReturnValue({ url: "https://r2.example/probe", contentType: "application/octet-stream" });
});

let prodId: string;
let uploader: string;    // 创建者行集（含 file@create），无通配 create
let wildcard: string;    // 持资产域通配 create
let scriptOnly: string;  // 只有 script/*/blocks@view —— 旧门放行、新门必须挡
let stranger: string;    // 成员，无任何 asset 授权
let outsider: string;    // 非成员

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

const probeReq = (userId: string) =>
  new NextRequest("http://localhost/api/presign-probe", { headers: { Cookie: cookieFor(userId) } });

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  uploader   = await newMember(prodId);
  wildcard   = await newMember(prodId);
  scriptOnly = await newMember(prodId);
  stranger   = await newMember(prodId);
  outsider   = await newMember(null);

  // uploader 只靠创建者行集拿 file@create；探针没有目标，这枚不够
  await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "设计图.pdf", mimeType: "application/pdf",
    storageType: "r2", r2Key: "assets/t605_v0/design.pdf", fileSize: 1000,
  });

  await grant(wildcard, "asset", "*", "*", "create");
  // 旧门恰好认这一枚——它是本次收敛的证人
  await grant(scriptOnly, "script", "*", "blocks", "view");
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("presign-probe 的门（#605）", () => {
  it("未登录 401；非成员 403", async () => {
    const noCookie = new NextRequest("http://localhost/api/presign-probe");
    expect((await probeGET(noCookie, ctx())).status).toBe(401);
    expect((await probeGET(probeReq(outsider), ctx())).status).toBe(403);
    expect(presignMock).not.toHaveBeenCalled();
  });

  it("只有 script/*/blocks@view 的成员 → 403（旧门会放行，这是收敛的证人）", async () => {
    expect((await probeGET(probeReq(scriptOnly), ctx())).status).toBe(403);
    expect(presignMock).not.toHaveBeenCalled();
  });

  it("无票成员 403；只有创建者行集（无通配 create）也 403", async () => {
    expect((await probeGET(probeReq(stranger), ctx())).status).toBe(403);
    expect((await probeGET(probeReq(uploader), ctx())).status).toBe(403);
    expect(presignMock).not.toHaveBeenCalled();
  });

  it("持通配 create 且无剧本读权 → 200，签的是固定探针 key", async () => {
    const res = await probeGET(probeReq(wildcard), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uploadUrl: "https://r2.example/probe" });
    expect(presignMock).toHaveBeenCalledTimes(1);
    expect(presignMock.mock.calls[0][0]).toBe("_internal/upload-speed-probe");
  });
});
