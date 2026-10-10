import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { seedLocalDemoScript } from "../../scripts/seed-local-demo-script";

let demoId: string;
let demoVersionId: string;

beforeAll(async () => {
  const production = await makeProduction();
  demoId = production.prodId;
  demoVersionId = production.versionId;
  await seedLocalDemoScript(demoId, demoVersionId);
});

afterAll(async () => {
  if (demoId) await cleanupProduction(demoId).catch(() => {});
});

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
  });
});
