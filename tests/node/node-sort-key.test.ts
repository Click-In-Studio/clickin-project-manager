import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { insertNode, tailSortKey, placementSortKey } from "@/lib/node/db";
import { getPool } from "@/lib/pg";

// #682：node 树同层追加 / 相对锚点落位的 sort_key 与剧本正文同一套定宽 key，
// 连续追加约 45 次就会耗尽并撞 key。tailSortKey / placementSortKey 无空位时整层重铺。

let prodId: string;
let folderId: string;

async function childrenInOrder(parentId: string): Promise<{ id: string; sort_key: string | null }[]> {
  const { rows } = await getPool().query<{ id: string; sort_key: string | null }>(
    "SELECT id, sort_key FROM node WHERE parent_id = $1 ORDER BY sort_key NULLS LAST, created_at",
    [parentId]);
  return rows;
}

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  folderId = await insertNode({
    productionId: prodId, kind: "folder", parentId: null,
    sortKey: await tailSortKey(prodId, null), title: "根目录", createdBy: null,
  });
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("node 同层 sort_key 不耗尽（#682）", () => {
  it("同一父下连续追加 80 个子节点：顺序 = 建立顺序，key 唯一", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) {
      ids.push(await insertNode({
        productionId: prodId, kind: "folder", parentId: folderId,
        sortKey: await tailSortKey(prodId, folderId), title: `子 ${i}`, createdBy: null,
      }));
    }
    const rows = await childrenInOrder(folderId);
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(new Set(rows.map((r) => r.sort_key)).size).toBe(rows.length);
  });

  it("相对同一锚点「之后」连续落位 60 次：后落的紧跟锚点（先落的被推后），key 唯一", async () => {
    const before = await childrenInOrder(folderId);
    const anchorId = before[0].id;
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const sortKey = await placementSortKey(prodId, folderId, { anchorId, side: "after" }, null);
      ids.push(await insertNode({ productionId: prodId, kind: "folder", parentId: folderId, sortKey, title: `插 ${i}`, createdBy: null }));
    }
    const rows = await childrenInOrder(folderId);
    const order = rows.map((r) => r.id);
    expect(order.indexOf(anchorId)).toBe(0);
    // 每次都插在锚点正后方 → 读回顺序是建立顺序的倒序
    expect(order.slice(1, 61)).toEqual([...ids].reverse());
    expect(order.slice(61)).toEqual(before.slice(1).map((r) => r.id));
    expect(new Set(rows.map((r) => r.sort_key)).size).toBe(rows.length);
  });

  it("相对锚点「之前」落位到最前 50 次：仍有序、key 唯一", async () => {
    const before = await childrenInOrder(folderId);
    const ids: string[] = [];
    let anchorId = before[0].id;
    for (let i = 0; i < 50; i++) {
      const sortKey = await placementSortKey(prodId, folderId, { anchorId, side: "before" }, null);
      anchorId = await insertNode({ productionId: prodId, kind: "folder", parentId: folderId, sortKey, title: `前 ${i}`, createdBy: null });
      ids.push(anchorId);
    }
    const rows = await childrenInOrder(folderId);
    expect(rows.slice(0, 50).map((r) => r.id)).toEqual([...ids].reverse());
    expect(new Set(rows.map((r) => r.sort_key)).size).toBe(rows.length);
  });
});
