import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createAsset } from "@/lib/asset/db";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { GET } from "@/app/api/production/[id]/assets/[assetId]/download-url/route";
import { makeProduction, cleanupProduction } from "../_support/factories";

vi.mock("@/lib/r2", () => ({ presignedGet: vi.fn(() => "https://files.example/download") }));

let prodId: string;
let otherProdId: string;
let owner: string;
let viewer: string;
let downloader: string;
let outsider: string;
const assets: string[] = [];

beforeAll(async () => {
  const users = (await getPool().query<{ id: string }>(
    "INSERT INTO app_user (id) SELECT gen_random_uuid() FROM generate_series(1,4) RETURNING id",
  )).rows.map(r => r.id);
  [owner, viewer, downloader, outsider] = users;
  ({ prodId } = await makeProduction(owner));
  ({ prodId: otherProdId } = await makeProduction(owner));
  for (const u of [viewer, downloader]) {
    await getPool().query("INSERT INTO production_member (production_id,user_id) VALUES ($1,$2)", [prodId,u]);
  }
  for (const storageType of ["r2", "feishu_link"] as const) {
    const { asset } = await createAsset({
      productionId: prodId, uploaderUserId: owner, assetType: "reference",
      fileName: "下载测试.pdf", mimeType: "application/pdf", storageType, isPublic: true,
      r2Key: storageType === "r2" ? "test/download.pdf" : null,
      feishuUrl: storageType === "feishu_link" ? "https://example.feishu.cn/test" : null,
    });
    assets.push(asset.id);
    for (const [u, subs] of [[viewer, ["meta"]], [downloader, ["meta", "file"]]] as const) {
      for (const sub of subs) await getPool().query(
        `INSERT INTO production_member_grant
          (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source)
         VALUES ($1,$2,'asset',$3,$4,'view','auto')`, [prodId,u,asset.id,sub],
      );
    }
  }
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
});

function download(userId: string | null, assetId: string, id = prodId) {
  const req = new NextRequest("http://localhost/api/download");
  if (userId) req.cookies.set(SESSION_COOKIE, createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false }));
  return GET(req, { params: Promise.resolve({ id, assetId }) });
}

describe.each([0,1])("下载授权（存储分支 %i）", index => {
  it("未登录 401、非成员 403", async () => {
    expect((await download(null, assets[index])).status).toBe(401);
    expect((await download(outsider, assets[index])).status).toBe(403);
  });
  it("仅持预览权 403；持文件读取权可以下载", async () => {
    expect((await download(viewer, assets[index])).status).toBe(403);
    const res = await download(downloader, assets[index]);
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBeTruthy();
  });
  it("非成员 owner 可下载；跨项目资产 404", async () => {
    expect((await download(owner, assets[index])).status).toBe(200);
    expect((await download(owner, assets[index], otherProdId)).status).toBe(404);
  });
});
