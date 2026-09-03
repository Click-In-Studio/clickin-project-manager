import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAsset, getAsset, updateAsset } from "@/lib/asset-db";
import { isAssetType, ASSET_TYPES, ASSET_TYPE_LABELS } from "@/lib/asset-types";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction } from "./factories";

// asset 元数据编辑（改名/改类型）：updateAsset 动态 SET + asset-types 白名单

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let uploader: string;
let assetId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  uploader = await newUser();
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
