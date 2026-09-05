// 资产工作台读面（#420 第二批 PR-C）：assetTreePaths（纯函数）与
// assetSizeStats（聚合）。边界覆盖 AI review 点名的几类：根级/断链/深链、
// 零文件行、NULL file_size 存量行。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { createAsset, assetTreePaths, assetSizeStats } from "@/lib/asset/db";
import { insertNode, listNodeLibrary } from "@/lib/node/db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let uploader: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  uploader = await newUser();
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("assetTreePaths", () => {
  it("深层 folder 链完整；缺省落资产根＝单段链；断链截断不炸", async () => {
    const outer = await insertNode({
      productionId: prodId, kind: "folder", parentId: null, sortKey: null,
      title: "交付", listable: true, createdBy: uploader,
    });
    const inner = await insertNode({
      productionId: prodId, kind: "folder", parentId: outer, sortKey: null,
      title: "第一批", listable: true, createdBy: uploader,
    });
    const deep = await createAsset({
      productionId: prodId, uploaderUserId: uploader, assetType: "reference",
      fileName: "deep.wav", mimeType: "audio/wav", storageType: "r2",
      nodeParentId: inner,
    });
    const rooted = await createAsset({
      productionId: prodId, uploaderUserId: uploader, assetType: "reference",
      fileName: "rooted.wav", mimeType: "audio/wav", storageType: "r2",
    });

    const paths = assetTreePaths(await listNodeLibrary(prodId));
    expect(paths.get(deep.asset.id)).toEqual(["交付", "第一批"]);
    expect(paths.get(rooted.asset.id)).toEqual(["资产"]);

    // 断链（父 id 不在库集合里）：截断到能解析的为止，不抛
    const broken = assetTreePaths([
      { id: "nd_x", parentId: "nd_ghost", assetId: "ast_x", displayTitle: "孤儿" },
    ]);
    expect(broken.get("ast_x")).toEqual([]);
  });
});

describe("assetSizeStats", () => {
  it("按资产聚合多文件行；NULL file_size 计 unknown 不计字节；零文件行资产无条目", async () => {
    const a = await createAsset({
      productionId: prodId, uploaderUserId: uploader, assetType: "reference",
      fileName: "sized.bin", mimeType: null, storageType: "r2", fileSize: 1000,
    });
    // 第二版本 + 一行 NULL 尺寸的存量形态
    await getPool().query(
      `INSERT INTO asset_file (id, asset_id, r2_key, file_size) VALUES ($1, $2, 'k2', 2500), ($3, $2, 'k3', NULL)`,
      [shortId(), a.asset.id, shortId()],
    );
    // 零文件行资产（feishu_link 也会有 file 行吗？造一个裸 asset 行验证缺行分支）
    const bare = shortId();
    await getPool().query(
      `INSERT INTO asset (id, production_id, uploader_user_id, file_name, storage_type)
       VALUES ($1, $2, $3::uuid, 'bare.txt', 'r2')`,
      [bare, prodId, uploader],
    );

    const stats = await assetSizeStats(prodId);
    expect(stats.sizeByAsset.get(a.asset.id)).toBe(3500);
    expect(stats.sizeByAsset.has(bare)).toBe(false);
    expect(stats.unknownFiles).toBeGreaterThanOrEqual(1);
    expect(stats.totalBytes).toBeGreaterThanOrEqual(3500);
  });
});
