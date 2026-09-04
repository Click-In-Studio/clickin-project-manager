import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import { WIKI_SPLIT_SNAPSHOT_PATH, type WikiSplitSnapshot } from "./wiki-split-snapshot";

// 批C PR-C1：report/note 本体拆分三层测试（快照顶层同步加载）。

let snapshot: WikiSplitSnapshot | null = null;
try {
  snapshot = JSON.parse(readFileSync(WIKI_SPLIT_SNAPSHOT_PATH, "utf8")) as WikiSplitSnapshot;
} catch { snapshot = null; }

describe("schema verification", () => {
  it("wiki and wiki_comment exist; content columns left the edge tables", async () => {
    for (const t of ["wiki", "wiki_comment"]) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [t]);
      expect(rows, `${t} 应存在`).toHaveLength(1);
    }
    for (const [t, c] of [["event_report", "body"], ["event_report", "title"],
                          ["event_report_note", "content"], ["event_report_note", "author_user_id"]] as const) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, c]);
      expect(rows, `${t}.${c} 应已搬迁`).toHaveLength(0);
    }
    const { rows } = await getPool().query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'event_report_reply'`);
    expect(rows, "reply 表应已拆入 wiki_comment").toHaveLength(0);
  });
});

describe("integrity verification", () => {
  it("all edges reference a node（#420 后边键在 node 上）", async () => {
    const { rows: r1 } = await getPool().query(
      `SELECT 1 FROM event_report WHERE node_id IS NULL LIMIT 1`);
    expect(r1).toHaveLength(0);
    const { rows: r2 } = await getPool().query(
      `SELECT 1 FROM event_report_note WHERE node_id IS NULL LIMIT 1`);
    expect(r2).toHaveLength(0);
  });
});

describe("invariance verification", () => {
  it.skipIf(!snapshot)("report content moved to wiki intact (title/body/author)", async () => {
    const { rows } = await getPool().query<{ title: string; body: string; created_by: string; production_id: string }>(
      `SELECT w.title, w.body, w.created_by, w.production_id
       FROM event_report er JOIN node nd ON nd.id = er.node_id
       JOIN wiki w ON w.id = nd.wiki_id WHERE er.id = $1`,
      [snapshot!.reportId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe(snapshot!.reportTitle);
    expect(rows[0].body).toBe(snapshot!.reportBody);
    expect(rows[0].created_by).toBe(snapshot!.noteAuthorId);
    expect(rows[0].production_id).toBe(snapshot!.productionId);
  });

  it.skipIf(!snapshot)("note content moved to wiki; dept relation stays on the edge", async () => {
    const { rows } = await getPool().query<{ body: string; created_by: string; department_id: string }>(
      `SELECT w.body, w.created_by, n.department_id
       FROM event_report_note n JOIN node nn ON nn.id = n.node_id
       JOIN wiki w ON w.id = nn.wiki_id WHERE n.id = $1`,
      [snapshot!.noteId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(snapshot!.noteContent);
    expect(rows[0].created_by).toBe(snapshot!.noteAuthorId);
  });

  it.skipIf(!snapshot)("note-parented reply became a wiki_comment on the note's wiki", async () => {
    const { rows } = await getPool().query<{ content: string }>(
      `SELECT wc.content
       FROM wiki_comment wc
       JOIN node nn ON nn.wiki_id = wc.wiki_id
       JOIN event_report_note n ON n.node_id = nn.id
       WHERE n.id = $1`,
      [snapshot!.noteId]);
    expect(rows.map((r) => r.content)).toContain(snapshot!.replyContent);
  });
});
