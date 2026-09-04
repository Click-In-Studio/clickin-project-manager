import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createAsset, getAsset, updateAsset, type Asset } from "@/lib/asset/db";
import { isAssetType, ASSET_TYPES, ASSET_TYPE_LABELS } from "@/lib/asset/types";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { PATCH as patchAsset } from "@/app/api/production/[id]/assets/[assetId]/route";
import { POST as postAssets } from "@/app/api/production/[id]/assets/route";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// asset 元数据编辑（改名/改类型）：updateAsset 动态 SET + asset-types 白名单
// + 路由层（AI review #406-1）：400 分支、trim/null 语义、403/404 门要过真 handler 验证

async function makeUser(tag: string): Promise<string> {
  return (await upsertFeishuUser(`test-open-${shortId()}`, `${tag}-${shortId()}`, null, false)).userId;
}

function req(userId: string, method: string, body?: unknown): NextRequest {
  const r = new NextRequest("http://localhost/api", {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
  r.cookies.set(SESSION_COOKIE, createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false }));
  return r;
}

let prodId: string;
let ownerId: string;
let uploader: string;   // 建 asset 的成员（创建者行集含 meta@edit）
let member: string;     // 普通成员，无任何 asset 授权
let assetId: string;

async function patchReq(userId: string, body: unknown, id = assetId) {
  return patchAsset(req(userId, "PATCH", body), {
    params: Promise.resolve({ id: prodId, assetId: id }),
  });
}

beforeAll(async () => {
  ownerId = await makeUser("ame-owner");
  uploader = await makeUser("ame-uploader");
  member = await makeUser("ame-member");
  ({ prodId } = await makeProduction(ownerId));
  for (const u of [uploader, member]) await addProductionMember(prodId, u);

  const { asset } = await createAsset({
    productionId: prodId, uploaderUserId: uploader, assetType: "reference",
    fileName: "original.pdf", mimeType: "application/pdf",
    storageType: "r2", isPublic: false,
  });
  assetId = asset.id;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("updateAsset", () => {
  it("设置显示名，不动其他字段", async () => {
    const updated = await updateAsset(assetId, { name: "音响设计图纸 v3" });
    expect(updated?.name).toBe("音响设计图纸 v3");
    expect(updated?.fileName).toBe("original.pdf");
    expect(updated?.assetType).toBe("reference");
  });

  it("改类型，不动名称", async () => {
    const updated = await updateAsset(assetId, { assetType: "drafting" });
    expect(updated?.assetType).toBe("drafting");
    expect(updated?.name).toBe("音响设计图纸 v3");
  });

  it("name 传 null 清除显示名（UI 回落 fileName）", async () => {
    const updated = await updateAsset(assetId, { name: null });
    expect(updated?.name).toBeNull();
  });

  it("同时改名 + 改类型", async () => {
    const updated = await updateAsset(assetId, { name: "合成回归", assetType: "score" });
    expect(updated?.name).toBe("合成回归");
    expect(updated?.assetType).toBe("score");
  });

  it("空 fields 是无操作读取，不产生 UPDATE", async () => {
    const before = await getAsset(assetId);
    const updated = await updateAsset(assetId, {});
    expect(updated).toEqual(before);
  });

  it("不存在的 asset 返回 null", async () => {
    expect(await updateAsset("ast_nonexistent", { name: "x" })).toBeNull();
  });
});

describe("isAssetType 白名单", () => {
  it("接受词汇表中的每个类型", () => {
    for (const t of ASSET_TYPES) expect(isAssetType(t)).toBe(true);
  });

  it("拒绝任意串 / 非串", () => {
    expect(isAssetType("evil'); DROP TABLE asset;--")).toBe(false);
    expect(isAssetType("")).toBe(false);
    expect(isAssetType(null)).toBe(false);
    expect(isAssetType(undefined)).toBe(false);
    expect(isAssetType(123)).toBe(false);
  });

  it("标签表与词汇表一一对应（防止两处漂移）", () => {
    expect(Object.keys(ASSET_TYPE_LABELS).sort()).toEqual([...ASSET_TYPES].sort());
  });
});

// ── 路由层：真 handler 走一遍 JSON 解析 / 校验 / 门 / 状态码 ──────────────────

describe("PATCH /assets/[assetId] 路由层", () => {
  it("uploader 改名 + 改类型 → 200，返回更新后的 asset", async () => {
    const res = await patchReq(uploader, { name: "路由层改名", assetType: "demo" });
    expect(res.status).toBe(200);
    const j = await res.json() as { asset: Asset };
    expect(j.asset.name).toBe("路由层改名");
    expect(j.asset.assetType).toBe("demo");
    expect(j.asset.fileName).toBe("original.pdf");
  });

  it("非法 assetType → 400 且不落库", async () => {
    const res = await patchReq(uploader, { assetType: "bogus_type" });
    expect(res.status).toBe(400);
    expect((await getAsset(assetId))?.assetType).toBe("demo");
  });

  it("name 非串非 null → 400", async () => {
    const res = await patchReq(uploader, { name: 123 });
    expect(res.status).toBe(400);
  });

  it("fileName 空白串 → 400（列 NOT NULL 但空串合法，会致卡片标题空白）", async () => {
    const res = await patchReq(uploader, { fileName: "   " });
    expect(res.status).toBe(400);
    expect((await getAsset(assetId))?.fileName).toBe("original.pdf");
  });

  it("显示名两端空白被 trim；纯空白串视同清除 → null", async () => {
    const r1 = await patchReq(uploader, { name: "  带空白  " });
    expect(((await r1.json()) as { asset: Asset }).asset.name).toBe("带空白");
    const r2 = await patchReq(uploader, { name: "  " });
    expect(((await r2.json()) as { asset: Asset }).asset.name).toBeNull();
  });

  it("无 meta@edit 的普通成员 → 403 且不落库", async () => {
    const res = await patchReq(member, { name: "越权改名" });
    expect(res.status).toBe(403);
    expect((await getAsset(assetId))?.name).not.toBe("越权改名");
  });

  it("owner 走 isOwner 旁路 → 200", async () => {
    const res = await patchReq(ownerId, { assetType: "reference" });
    expect(res.status).toBe(200);
  });

  it("asset 不存在 → 404", async () => {
    const res = await patchReq(uploader, { name: "x" }, "ast_nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("POST /assets 路由层（上传口同源白名单）", () => {
  it("非法 assetType → 400（feishu 分支，先于 createAsset）", async () => {
    const res = await postAssets(
      req(ownerId, "POST", {
        storageType: "feishu_link", feishuUrl: "https://example.feishu.cn/x",
        fileName: "评审用.pdf", assetType: "bogus_type",
      }),
      { params: Promise.resolve({ id: prodId }) },
    );
    expect(res.status).toBe(400);
  });

  it("合法 assetType → 201", async () => {
    const res = await postAssets(
      req(ownerId, "POST", {
        storageType: "feishu_link", feishuUrl: "https://example.feishu.cn/x",
        fileName: "评审用.pdf", assetType: "score",
      }),
      { params: Promise.resolve({ id: prodId }) },
    );
    expect(res.status).toBe(201);
    const j = await res.json() as { asset: Asset };
    expect(j.asset.assetType).toBe("score");
  });
});
