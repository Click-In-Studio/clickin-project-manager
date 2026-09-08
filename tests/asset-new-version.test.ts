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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createAsset, getAsset, listAssets, resolveAssetFile } from "@/lib/asset/db";
import { POST as filesPOST } from "@/app/api/production/[id]/assets/[assetId]/files/route";
import { POST as presignPOST } from "@/app/api/production/[id]/assets/presign/route";
import { makeProduction, cleanupProduction } from "./factories";

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
    storageType: "r2", r2Key: "assets/af_v1/design.pdf", fileSize: 1000,
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
    storageType: "r2", r2Key: "assets/af_other/x.pdf", fileSize: 10,
  });
  foreignAssetId = foreign.asset.id;
});

afterAll(async () => {
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
        r2Key: "assets/af_v2/设计图_v2.dwg",
        fileId: "af_v2",
        fileName: "设计图 v2.dwg",
        mimeType: "image/vnd.dwg",
        fileSize: 2048,
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
    expect(latest?.r2Key).toBe("assets/af_v2/设计图_v2.dwg");
    expect(latest?.fileSize).toBe(2048);
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
      jsonReq(uploader, { storageType: "r2", r2Key: "assets/af_x/a.pdf", fileName: "a.pdf" }),
      ctxFor(prodId, feishuAssetId));
    expect(res.status).toBe(400);
  });
});

describe("追加版本的门", () => {
  it("成员但无 file@create → 403；非成员 → 403", async () => {
    const body = { storageType: "r2", r2Key: "assets/af_v9/x.pdf", fileName: "x.pdf" };
    expect((await filesPOST(jsonReq(stranger, body), ctxFor(prodId, assetId))).status).toBe(403);
    expect((await filesPOST(jsonReq(outsider, body), ctxFor(prodId, assetId))).status).toBe(403);
  });

  it("assetId 属于别的演出 → 404（不因 uploader 在那边有票而放行）", async () => {
    const res = await filesPOST(
      jsonReq(uploader, { storageType: "r2", r2Key: "assets/af_v9/x.pdf", fileName: "x.pdf" }),
      ctxFor(prodId, foreignAssetId));
    expect(res.status).toBe(404);
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
