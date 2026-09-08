// #456「上传新版本」接线：模态此前不传目标资产，面板走的是创建端点——UI 上点
// 「新版本」实际多出一个全新 asset，同资产追加版本从界面不可达；
// assets/<id>/files 路由则全仓零调用方。
//
// 这里守的是接线后的契约：
//   · 注册只加 asset_file 行，**不新建 asset**（回归本体）
//   · asset 行的 file_name/mime_type 跟着最新文件走（读侧 latest-wins 的一致性）
//   · 路由只收 JSON（改造前的 FormData 整文件形态不再受理）
//   · presign 带 assetId 时的门＝file@create（只有创建者行集、无通配 create 的
//     上传者也能签出 URL——接线前这条路是死的）
//   · 注册前 HEAD 确认字节真在，大小以 R2 的 Content-Length 为准
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createAsset, getAsset, listAssets, resolveAssetFile } from "@/lib/asset/db";
import { canUploadAssetBytes } from "@/lib/asset/perm";
import { POST as filesPOST } from "@/app/api/production/[id]/assets/[assetId]/files/route";
import { POST as presignPOST } from "@/app/api/production/[id]/assets/presign/route";
import { makeProduction, cleanupProduction } from "./factories";

// R2 只替换本 PR 用到的三个出入口，其余导出（签名等纯函数）保持真身
const { headMock, listPartsMock, completeMock } = vi.hoisted(() => ({
  headMock: vi.fn(), listPartsMock: vi.fn(), completeMock: vi.fn(),
}));
vi.mock("@/lib/r2", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/r2")>(),
  headR2Object: headMock,
  listMultipartParts: listPartsMock,
  completeMultipartUpload: completeMock,
}));

beforeEach(() => {
  headMock.mockReset().mockResolvedValue({ size: 2048, contentType: null });
  listPartsMock.mockReset().mockResolvedValue([{ partNumber: 1, eTag: "e1" }]);
  completeMock.mockReset().mockResolvedValue(undefined);
});

let prodId: string;
let otherProdId: string;
let uploader: string;    // 创建者行集（含 file@create），无通配 create
let stranger: string;    // 成员，无任何 asset 授权
let outsider: string;    // 非成员
let assetId: string;
let feishuAssetId: string;
let foreignAssetId: string;   // 另一个演出里的资产

const cookieFor = (userId: string) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;

function jsonReq(userId: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/files", {
    method: "POST",
    headers: { Cookie: cookieFor(userId), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctxFor = (pid: string, aid: string) => ({ params: Promise.resolve({ id: pid, assetId: aid }) });

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

async function fileCount(aid: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM asset_file WHERE asset_id = $1`, [aid]);
  return Number(rows[0].n);
}

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  ({ prodId: otherProdId } = await makeProduction());
  uploader = await newMember(prodId);
  stranger = await newMember(prodId);
  outsider = await newMember(null);

  const created = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "设计图.pdf", mimeType: "application/pdf",
    storageType: "r2", r2Key: "assets/t456_v1/design.pdf", fileSize: 1000,
  });
  assetId = created.asset.id;

  const feishu = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "外链.doc", mimeType: null,
    storageType: "feishu_link", feishuUrl: "https://example.feishu.cn/wiki/x",
  });
  feishuAssetId = feishu.asset.id;

  const foreign = await createAsset({
    productionId: otherProdId, uploaderUserId: uploader, assetType: "reference",
    fileName: "别家.pdf", mimeType: "application/pdf",
    storageType: "r2", r2Key: "assets/t456_other/x.pdf", fileSize: 10,
  });
  foreignAssetId = foreign.asset.id;
});

afterAll(async () => {
  // 注册成功会投缩略图/解析预热作业（asset-jobs），job 表不随演出级联删除。
  // 不回收的话这些 queued 行跨 run 累积，把 job-queue 测试的 claimJobs(limit)
  // 挤爆——本文件的 r2Key 统一带 t456_ 前缀就是为了能精确认领自己的残留。
  await getPool().query(`DELETE FROM job WHERE payload->>'r2Key' LIKE 'assets/t456_%'`).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});

describe("追加版本注册", () => {
  it("只加 asset_file 行，不新建 asset；元数据跟着最新文件走", async () => {
    const before = (await listAssets(prodId)).length;
    expect(await fileCount(assetId)).toBe(1);

    const res = await filesPOST(
      jsonReq(uploader, {
        storageType: "r2",
        r2Key: "assets/t456_v2/设计图_v2.dwg",
        fileId: "af_v2",
        fileName: "设计图 v2.dwg",
        mimeType: "image/vnd.dwg",
        fileSize: 999999,   // 客户端自报的不作数，落库应是 HEAD 的 2048
      }),
      ctxFor(prodId, assetId),
    );
    expect(res.status).toBe(201);
    const j = await res.json() as { asset: { id: string; fileName: string; mimeType: string | null }; file: { id: string } };

    // 回归本体：资产总数不变，返回的还是同一个 asset
    expect((await listAssets(prodId)).length).toBe(before);
    expect(j.asset.id).toBe(assetId);
    expect(await fileCount(assetId)).toBe(2);

    // latest-wins：读侧指向新文件，asset 行的名字/类型同步
    const latest = await resolveAssetFile(assetId);
    expect(latest?.r2Key).toBe("assets/t456_v2/设计图_v2.dwg");
    expect(latest?.fileSize).toBe(2048);   // 取 HEAD 的 Content-Length，不是客户端报的 999999
    expect(j.asset.fileName).toBe("设计图 v2.dwg");
    const reread = await getAsset(assetId);
    expect(reread?.fileName).toBe("设计图 v2.dwg");
    expect(reread?.mimeType).toBe("image/vnd.dwg");
  });

  it("非 JSON（改造前的 FormData 整文件形态）不再受理", async () => {
    const fd = new FormData();
    fd.set("file", new File(["x"], "a.pdf", { type: "application/pdf" }));
    const res = await filesPOST(
      new NextRequest("http://localhost/api/files", {
        method: "POST", headers: { Cookie: cookieFor(uploader) }, body: fd,
      }),
      ctxFor(prodId, assetId),
    );
    expect(res.status).toBe(415);
  });

  it("缺字段 / r2Key 越出 assets/ 前缀 → 400", async () => {
    const missing = await filesPOST(
      jsonReq(uploader, { storageType: "r2", fileName: "x.pdf" }),
      ctxFor(prodId, assetId));
    expect(missing.status).toBe(400);

    const before = await fileCount(assetId);
    const escaped = await filesPOST(
      jsonReq(uploader, { storageType: "r2", r2Key: "thumbnails/af_v1.webp", fileName: "x.webp" }),
      ctxFor(prodId, assetId));
    expect(escaped.status).toBe(400);
    expect(await fileCount(assetId)).toBe(before);
  });

  it("飞书外链资产不能追加 R2 版本 → 400", async () => {
    const res = await filesPOST(
      jsonReq(uploader, { storageType: "r2", r2Key: "assets/t456_x/a.pdf", fileName: "a.pdf" }),
      ctxFor(prodId, feishuAssetId));
    expect(res.status).toBe(400);
  });
});

describe("注册前的对象存在性探测", () => {
  it("R2 明确答不存在 → 409，且一行不写（latest-wins 下这会砸掉已有资产的读面）", async () => {
    headMock.mockResolvedValue(null);
    const before = await fileCount(assetId);
    const nameBefore = (await getAsset(assetId))?.fileName;

    const res = await filesPOST(
      jsonReq(uploader, {
        storageType: "r2", r2Key: "assets/t456_ghost/never-uploaded.pdf",
        fileName: "幽灵.pdf", mimeType: "application/pdf", fileSize: 10,
      }),
      ctxFor(prodId, assetId));
    expect(res.status).toBe(409);
    expect(await fileCount(assetId)).toBe(before);
    expect((await getAsset(assetId))?.fileName).toBe(nameBefore);
  });

  it("探测问不出来（5xx / 无凭据）→ 放行，大小回落到客户端自报值", async () => {
    headMock.mockRejectedValue(new Error("R2 HEAD failed: 503"));
    const res = await filesPOST(
      jsonReq(uploader, {
        storageType: "r2", r2Key: "assets/t456_flaky/v3.pdf",
        fileName: "抖动.pdf", mimeType: "application/pdf", fileSize: 4096,
      }),
      ctxFor(prodId, assetId));
    expect(res.status).toBe(201);
    const latest = await resolveAssetFile(assetId);
    expect(latest?.r2Key).toBe("assets/t456_flaky/v3.pdf");
    expect(latest?.fileSize).toBe(4096);
  });

  it("分段上传分支：先 complete 再探测，成功后注册", async () => {
    headMock.mockResolvedValue({ size: 88, contentType: null });
    const res = await filesPOST(
      jsonReq(uploader, {
        storageType: "r2-multipart", r2Key: "assets/t456_mp/big.mov",
        uploadId: "up_1", fileName: "大文件.mov", mimeType: "video/quicktime", fileSize: 1,
      }),
      ctxFor(prodId, assetId));
    expect(res.status).toBe(201);
    expect(listPartsMock).toHaveBeenCalledWith("assets/t456_mp/big.mov", "up_1");
    expect(completeMock).toHaveBeenCalled();
    expect((await resolveAssetFile(assetId))?.fileSize).toBe(88);
  });

  it("分段上传缺 uploadId → 400，不碰 R2", async () => {
    const res = await filesPOST(
      jsonReq(uploader, {
        storageType: "r2-multipart", r2Key: "assets/t456_mp/big.mov", fileName: "大文件.mov",
      }),
      ctxFor(prodId, assetId));
    expect(res.status).toBe(400);
    expect(completeMock).not.toHaveBeenCalled();
  });
});

describe("追加版本的门", () => {
  it("成员但无 file@create → 403；非成员 → 403", async () => {
    const body = { storageType: "r2", r2Key: "assets/t456_v9/x.pdf", fileName: "x.pdf" };
    expect((await filesPOST(jsonReq(stranger, body), ctxFor(prodId, assetId))).status).toBe(403);
    expect((await filesPOST(jsonReq(outsider, body), ctxFor(prodId, assetId))).status).toBe(403);
  });

  it("assetId 属于别的演出 → 404（不因 uploader 在那边有票而放行）", async () => {
    const res = await filesPOST(
      jsonReq(uploader, { storageType: "r2", r2Key: "assets/t456_v9/x.pdf", fileName: "x.pdf" }),
      ctxFor(prodId, foreignAssetId));
    expect(res.status).toBe(404);
  });
});

// 三条 presign 路由共用这一把门，值得直接钉矩阵，不只靠路由测间接覆盖
describe("canUploadAssetBytes 矩阵", () => {
  const actor = (userId: string, bits: { isAdmin?: boolean; isOwner?: boolean } = {}) =>
    ({ userId, isAdmin: bits.isAdmin ?? false, isOwner: bits.isOwner ?? false });

  let wildcard: string;   // 持资产域通配 create（角色型上传者）

  beforeAll(async () => {
    wildcard = await newMember(prodId);
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2, 'asset', '*', '*', 'create', 'auto')
       ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
         WHERE is_revoked = false DO NOTHING`,
      [prodId, wildcard],
    );
  });

  it("admin / owner 两种目标都放行", async () => {
    for (const bits of [{ isAdmin: true }, { isOwner: true }]) {
      expect(await canUploadAssetBytes(actor("nobody", bits), prodId, null)).toBe(true);
      expect(await canUploadAssetBytes(actor("nobody", bits), prodId, assetId)).toBe(true);
    }
  });

  it("只有创建者行集（file@create）：带目标放行，不带目标不放行", async () => {
    // 后者正是接线前新版本上传的死点——面板打的是新建的门，他没有
    expect(await canUploadAssetBytes(actor(uploader), prodId, assetId)).toBe(true);
    expect(await canUploadAssetBytes(actor(uploader), prodId, null)).toBe(false);
  });

  it("持通配 create：两种目标都放行（分叉是放宽不是收紧）", async () => {
    // hasGrant 的 resource_id IN (id, '*') 语义下，通配本来就满足 file@create
    expect(await canUploadAssetBytes(actor(wildcard), prodId, null)).toBe(true);
    expect(await canUploadAssetBytes(actor(wildcard), prodId, assetId)).toBe(true);
  });

  it("无票成员：两种目标都不放行", async () => {
    expect(await canUploadAssetBytes(actor(stranger), prodId, null)).toBe(false);
    expect(await canUploadAssetBytes(actor(stranger), prodId, assetId)).toBe(false);
  });
});

describe("presign 的门按目标分叉（#456 接线的前置）", () => {
  const presignReq = (userId: string, body: unknown) =>
    new NextRequest("http://localhost/api/presign", {
      method: "POST",
      headers: { Cookie: cookieFor(userId), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const pctx = () => ({ params: Promise.resolve({ id: prodId }) });

  it("只有创建者行集（无通配 create）：带 assetId 能签出，不带则 403", async () => {
    // 不带 assetId＝新建资产的门（通配 create），uploader 没有 → 403。
    // 这正是接线前新版本上传的死点：字节根本签不出去。
    const asNew = await presignPOST(
      presignReq(uploader, { fileName: "v2.pdf", mimeType: "application/pdf" }), pctx());
    expect(asNew.status).toBe(403);

    const asVersion = await presignPOST(
      presignReq(uploader, { fileName: "v2.pdf", mimeType: "application/pdf", assetId }), pctx());
    expect(asVersion.status).toBe(200);
    const j = await asVersion.json() as { r2Key: string };
    expect(j.r2Key.startsWith("assets/")).toBe(true);
  });

  it("无 file@create 的成员带 assetId 也签不出 → 403", async () => {
    const res = await presignPOST(
      presignReq(stranger, { fileName: "v2.pdf", mimeType: "application/pdf", assetId }), pctx());
    expect(res.status).toBe(403);
  });
});
