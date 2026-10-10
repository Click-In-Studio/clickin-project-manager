import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { NextRequest } from "next/server";
import { createSession } from "@/lib/account/session";
import { GET, POST, PUT } from "@/app/api/production/[id]/scenes/route";
import { loadProduction } from "@/lib/script/script-state-db";
import * as markerTx from "@/lib/script/script-marker-tx";
import type { MarkerProjection } from "@/lib/script/script-marker-domain";
import { seedLocalDemoScript } from "../../scripts/seed-local-demo-script";

let demoId: string;
let demoVersionId: string;
let fresh: { prodId: string; versionId: string };

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "local-demo-regression-secret");
  const production = await makeProduction();
  demoId = production.prodId;
  demoVersionId = production.versionId;
  await seedLocalDemoScript(demoId, demoVersionId);
  fresh = await makeProduction();
});

afterAll(async () => {
  if (demoId) await cleanupProduction(demoId).catch(() => {});
  if (fresh) await cleanupProduction(fresh.prodId).catch(() => {});
  vi.unstubAllEnvs();
});

async function call(productionId: string, versionId: string, method: "GET" | "POST" | "PUT", body: Record<string, unknown> = {}) {
  const owner = (await getPool().query<{ owner_id: string }>("SELECT owner_id FROM production WHERE id=$1", [productionId])).rows[0].owner_id;
  const session = createSession({ userId: owner, name: "测试 owner", avatarUrl: null, isAdmin: false });
  const req = new NextRequest(`http://localhost/api/production/${productionId}/scenes?versionId=${versionId}`, {
    method, headers: { cookie: `sid=${session}`, "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify({ versionId, ...body }) }),
  });
  return ({ GET, POST, PUT }[method])(req, { params: Promise.resolve({ id: productionId }) });
}

async function read(productionId: string, versionId: string): Promise<MarkerProjection[]> {
  const response = await call(productionId, versionId, "GET");
  expect(response.status).toBe(200);
  return response.json();
}

async function add(productionId: string, versionId: string, name: string, parentId: string | null): Promise<MarkerProjection> {
  const response = await call(productionId, versionId, "POST", { name, parentId });
  expect(response.status).toBe(201);
  const data = await response.json();
  expect(data.ok).toBe(true);
  expect((await read(productionId, versionId)).map(marker => marker.id)).toEqual(data.scenes.map((marker: MarkerProjection) => marker.id));
  return data.scenes.find((marker: MarkerProjection) => marker.name === name);
}

async function snapshot(productionId: string, versionId: string) {
  const loaded = await loadProduction(productionId, versionId);
  expect(loaded).not.toBeNull();
  return loaded!.state;
}

describe("本地演示剧本标记", () => {
  it("seed 为所有章节和段落建立身份锚，并同步归属和派生详情", async () => {
    const { rows } = await getPool().query<{
      block_id: string; type: string; scene_id: string | null; anchor_id: string | null;
      projected_id: string | null; stage_notes: string | null; parent_id: string | null;
    }>(
      `SELECT s.block_id, s.type, s.scene_id, a.id AS anchor_id, d.scene_id AS projected_id,
              d.stage_notes, d.parent_id
       FROM script_version v JOIN script s ON s.id = v.snapshot_id
       LEFT JOIN scene a ON a.id = s.block_id AND a.production_id = s.production_id
       LEFT JOIN scene_version d ON d.scene_id = s.block_id AND d.version_id = v.version_id
       WHERE v.version_id = $1 AND s.type IN ('chapter_marker', 'scene_marker') ORDER BY v.sort_key`,
      [demoVersionId],
    );
    expect(rows).toHaveLength(4);
    const chapter = rows.find(row => row.type === "chapter_marker")!;
    for (const row of rows) {
      expect(row.anchor_id).toBe(row.block_id);
      expect(row.scene_id).toBe(row.block_id);
      expect(row.projected_id).toBe(row.block_id);
      if (row.type === "scene_marker") {
        expect(row.parent_id).toBe(chapter.block_id);
        expect(row.stage_notes).toContain("注意转台安全线");
      }
    }
    const text = await getPool().query<{ content: string; owner_marker_id: string | null }>(
      `SELECT s.content, s.owner_marker_id FROM script_version v JOIN script s ON s.id=v.snapshot_id
       WHERE v.version_id=$1 AND s.type='dialogue'`, [demoVersionId],
    );
    expect(text.rows).toHaveLength(2);
    expect(text.rows.every(row => rows.some(marker => marker.block_id === row.owner_marker_id))).toBe(true);
    expect(text.rows.some(row => row.content.includes("这封信没有日期"))).toBe(true);
    const characters = await getPool().query<{ biography: string; role_type: string; gender: string | null }>(
      "SELECT biography, role_type, gender FROM character_version WHERE version_id=$1", [demoVersionId],
    );
    expect(characters.rows).toHaveLength(3);
    expect(characters.rows.every(row => row.biography && row.role_type)).toBe(true);
    expect(characters.rows.filter(row => row.gender === null)).toHaveLength(1);
  });
  it.each(["演示数据", "正常新建数据"])("%s 的新增、同章排序、章边界和整章移动可以持久化", async kind => {
    const productionId = kind === "演示数据" ? demoId : fresh.prodId;
    const versionId = kind === "演示数据" ? demoVersionId : fresh.versionId;
    let initial = await read(productionId, versionId);
    if (kind === "正常新建数据") {
      const chapter = await add(productionId, versionId, "第一章", null);
      await add(productionId, versionId, "第一段", chapter.id);
      await add(productionId, versionId, "第二段", chapter.id);
      initial = await read(productionId, versionId);
    }
    const opening = initial.find(marker => marker.kind === "chapter")!;
    const peers = initial.filter(marker => marker.kind === "scene" && marker.parentId === opening.id);
    expect(peers.length).toBeGreaterThanOrEqual(2);
    const chapterB = await add(productionId, versionId, "第二章", null);
    const childB = await add(productionId, versionId, "第二章段落", chapterB.id);
    const chapterC = await add(productionId, versionId, "第三章", null);
    const childC = await add(productionId, versionId, "第三章段落", chapterC.id);
    const contentBefore = (await snapshot(productionId, versionId)).blocks.map(block => ({ id: block.id, content: block.content, characterIds: block.characterIds })).sort((a, b) => a.id.localeCompare(b.id));
    const move = async (markerId: string, beforeMarkerId: string | null) => {
      const response = await call(productionId, versionId, "PUT", { markerId, beforeMarkerId });
      expect(response.status).toBe(200);
      const data = await response.json();
      const reread = await read(productionId, versionId);
      expect(reread.map(marker => marker.id)).toEqual(data.scenes.map((marker: MarkerProjection) => marker.id));
      expect((await snapshot(productionId, versionId)).blocks.filter(block => block.type === "chapter_marker" || block.type === "scene_marker").map(block => block.id)).toEqual(reread.map(marker => marker.id));
      return reread;
    };
    let rows = await move(peers[1].id, peers[0].id);
    expect(rows.findIndex(marker => marker.id === peers[1].id)).toBeLessThan(rows.findIndex(marker => marker.id === peers[0].id));
    rows = await move(peers[1].id, chapterB.id);
    expect(rows.filter(marker => marker.parentId === opening.id).at(-1)!.id).toBe(peers[1].id);
    rows = await move(peers[1].id, peers[0].id);
    expect(rows.filter(marker => marker.parentId === opening.id)[0].id).toBe(peers[1].id);
    const beforeChapterMove = await snapshot(productionId, versionId);
    const chapterOwnedIds = beforeChapterMove.blocks.slice(
      beforeChapterMove.blocks.findIndex(block => block.id === chapterB.id),
      beforeChapterMove.blocks.findIndex(block => block.id === chapterC.id),
    ).map(block => block.id);
    rows = await move(chapterB.id, null);
    expect(rows.filter(marker => marker.kind === "chapter").map(marker => marker.id)).toEqual([opening.id, chapterC.id, chapterB.id]);
    expect(rows.find(marker => marker.id === childB.id)!.parentId).toBe(chapterB.id);
    expect(rows.find(marker => marker.id === childC.id)!.parentId).toBe(chapterC.id);
    const after = await snapshot(productionId, versionId);
    expect(after.config.openingChapterMarkerId).toBe(opening.id);
    expect(after.blocks.slice(after.blocks.findIndex(block => block.id === chapterB.id)).map(block => block.id)).toEqual(chapterOwnedIds);
    expect(after.blocks.map(block => ({ id: block.id, content: block.content, characterIds: block.characterIds })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(contentBefore);
    const invalidBefore = await snapshot(productionId, versionId);
    expect((await call(productionId, versionId, "PUT", { markerId: opening.id, beforeMarkerId: null })).status).toBe(400);
    expect((await call(productionId, versionId, "PUT", { markerId: peers[0].id, beforeMarkerId: childC.id })).status).toBe(400);
    expect(await snapshot(productionId, versionId)).toEqual(invalidBefore);
  });
  it("排序事务在收尾失败时完整回滚", async () => {
    const rows = await read(demoId, demoVersionId);
    const peers = rows.filter(marker => marker.kind === "scene" && marker.parentId === rows[0].id);
    const before = await snapshot(demoId, demoVersionId);
    const fail = vi.spyOn(markerTx, "finalizeMarkerInvariantsInTx").mockRejectedValueOnce(new Error("模拟事务收尾失败"));
    try {
      await expect(call(demoId, demoVersionId, "PUT", { markerId: peers.at(-1)!.id, beforeMarkerId: peers[0].id })).rejects.toThrow("模拟事务收尾失败");
    } finally { fail.mockRestore(); }
    expect(await snapshot(demoId, demoVersionId)).toEqual(before);
    expect((await read(demoId, demoVersionId)).map(marker => marker.id)).toEqual(rows.map(marker => marker.id));
  });

  it("未登录、非成员和只持字段编辑权限均不能排序，拒绝后没有写入", async () => {
    const rows = await read(demoId, demoVersionId);
    const peers = rows.filter(marker => marker.kind === "scene" && marker.parentId === rows[0].id);
    const body = JSON.stringify({ versionId: demoVersionId, markerId: peers.at(-1)!.id, beforeMarkerId: peers[0].id });
    const context = { params: Promise.resolve({ id: demoId }) };
    const before = await snapshot(demoId, demoVersionId);
    const request = (sid?: string) => new NextRequest(`http://localhost/api/production/${demoId}/scenes`, {
      method: "PUT", body, headers: { "Content-Type": "application/json", ...(sid ? { cookie: `sid=${sid}` } : {}) },
    });
    expect((await PUT(request(), context)).status).toBe(401);
    const userId = (await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
    const session = createSession({ userId, name: "测试成员", avatarUrl: null, isAdmin: false });
    try {
      expect((await PUT(request(session), context)).status).toBe(403);
      await getPool().query("INSERT INTO production_member (production_id,user_id,roles) VALUES ($1,$2,'{}')", [demoId, userId]);
      await getPool().query(
        `INSERT INTO production_member_grant
         (production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source,confirmed_by)
         VALUES ($1,$2,'scene','*','meta/name','edit','direct',$2)`, [demoId, userId],
      );
      expect((await PUT(request(session), context)).status).toBe(403);
      expect(await snapshot(demoId, demoVersionId)).toEqual(before);
    } finally {
      await getPool().query("DELETE FROM app_user WHERE id=$1", [userId]);
    }
  });

});
