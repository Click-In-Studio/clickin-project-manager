/**
 * Migration tests for migrate-cue-mention-stable-id.sql（cue 引用换锚，#302）.
 *
 * Migration path (CI): global-setup 检测 cue.cue_id 仍可空 → 裸 SQL 造锚行 id 的
 *   存量形态（正文四列 + 边表）→ 应用迁移 → 写快照。
 * Normal path (本地已迁移库): 快照不存在，invariance skipIf 跳过。
 *
 * Layers: 1 schema（cue_id 收 NOT NULL、备份表就位）
 *         2 integrity（全库无锚修订行 id 的正文引用与边）
 *         3 invariance（工厂正文/边逐条平移到 cue_id，含前缀咬断与边去重两个陷阱）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { getPool } from "@/lib/pg";
import {
  CUE_MENTION_STABLE_ID_SNAPSHOT_PATH,
  type CueMentionStableIdSnapshot,
} from "./cue-mention-stable-id-snapshot";

let snapshot: CueMentionStableIdSnapshot | null = null;
try {
  snapshot = JSON.parse(
    readFileSync(CUE_MENTION_STABLE_ID_SNAPSHOT_PATH, "utf8"),
  ) as CueMentionStableIdSnapshot;
} catch {
  snapshot = null;
}

// 正文四列（与 migrate-wiki-dialect-v2 盘清的列集一致）
const TEXT_COLUMNS: [table: string, col: string][] = [
  ["wiki", "body"],
  ["comment", "body"],
  ["user_notification", "body"],
  ["agent_memory_chunk", "text"],
];

// ── 1. Schema verification ────────────────────────────────────────────────────

describe("schema verification", () => {
  it("cue.cue_id is NOT NULL", async () => {
    const { rows } = await getPool().query<{ data_type: string; is_nullable: string }>(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cue' AND column_name = 'cue_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("cue_mention_text_backup exists with the generic four-column shape", async () => {
    const { rows } = await getPool().query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cue_mention_text_backup'
    `);
    const cols = new Map(rows.map(r => [r.column_name, r.is_nullable]));
    for (const c of ["table_name", "row_id", "column_name", "body", "taken_at"]) {
      expect(cols.get(c)).toBe("NO");
    }
  });
});

// ── 2. Integrity verification ─────────────────────────────────────────────────

describe("integrity verification", () => {
  it("no cue row left with a NULL logical id", async () => {
    const { rows } = await getPool().query(`SELECT 1 FROM cue WHERE cue_id IS NULL`);
    expect(rows).toHaveLength(0);
  });

  it("no wiki_entity_link cue edge anchors a non-initial revision row", async () => {
    // 边锚的若是 CoW 出来的修订行 id（cue_id <> id），改一次 cue 它就成了幻影。
    const { rows } = await getPool().query<{ entity_id: string }>(`
      SELECT l.entity_id FROM wiki_entity_link l
      JOIN cue c ON c.id = l.entity_id
      WHERE l.entity_type = 'cue' AND c.cue_id <> c.id
    `);
    expect(rows).toEqual([]);
  });

  it.each(TEXT_COLUMNS)(
    "%s.%s carries no cue mention anchored on a revision row id",
    async (table, col) => {
      // 分隔符集合取自 lib/wiki-db.ts 的 CM_HREF_RE / CM_HREF_LEGACY_RE
      const { rows } = await getPool().query(`
        WITH bad AS (SELECT id FROM cue WHERE cue_id <> id)
        SELECT 1 FROM ${table} t, bad
        WHERE t.${col} ~ ('/__cm__/cue/' || bad.id || '[)?#&]')
           OR t.${col} ~ ('/__cm__cue:'  || bad.id || '[):?&]')
      `);
      expect(rows).toHaveLength(0);
    },
  );
});

// ── 3. Invariance verification ────────────────────────────────────────────────

describe("invariance verification", () => {
  it.skipIf(!snapshot)("legacy NULL cue_id backfills to the row's own id", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ cue_id: string }>(
      `SELECT cue_id FROM cue WHERE id = $1`, [s.legacyNullCue],
    );
    expect(rows[0]?.cue_id).toBe(s.legacyNullCue);
  });

  it.skipIf(!snapshot)("wiki body: every revision-anchored mention moves to its cue_id", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ body: string }>(
      `SELECT body FROM wiki WHERE id = $1::uuid`, [s.wikiId],
    );
    const body = rows[0].body;

    // v2 形态、带 # 锚、带 ?as= 参数三处都平移
    expect(body).toContain(`(/__cm__/cue/${s.logicalA})`);
    expect(body).toContain(`(/__cm__/cue/${s.logicalA}#note)`);
    expect(body).toContain(`(/__cm__/cue/${s.logicalA}?as=x)`);
    // v1 存量形态也收
    expect(body).toContain(`(/__cm__cue:${s.logicalA}?v=v1)`);
    // 旧行 id 一个不留
    expect(body).not.toContain(`/__cm__/cue/${s.revA2}`);
    expect(body).not.toContain(`/__cm__cue:${s.revAshort}`);
  });

  it.skipIf(!snapshot)("prefix trap: a longer row id is not truncated by a shorter remap key", async () => {
    const s = snapshot!;
    // revBprefixed = revAshort + "x"，且 revAshort 自己就是一条 remap 键。
    // 裸 replace 会把它咬成 `logicalA + "x"`——这条断言就是那个咬痕的探针。
    const { rows } = await getPool().query<{ body: string }>(
      `SELECT body FROM wiki WHERE id = $1::uuid`, [s.wikiId],
    );
    const body = rows[0].body;
    expect(body).toContain(`(/__cm__/cue/${s.logicalB})`);
    expect(body).not.toContain(`${s.logicalA}x`);
  });

  it.skipIf(!snapshot)("non-cue kinds and bare text are left alone", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ body: string }>(
      `SELECT body FROM wiki WHERE id = $1::uuid`, [s.wikiId],
    );
    const body = rows[0].body;
    expect(body).toContain(`/__cm__/scene/${s.revA2}`);   // 别的 kind 不碰
    expect(body).toContain(`${s.revAshort} 裸文本`);       // 无分隔符的裸 id 不碰
  });

  it.skipIf(!snapshot)("comment / notification / agent memory move too", async () => {
    const s = snapshot!;
    const pool = getPool();
    const [c, n, m] = await Promise.all([
      pool.query<{ body: string }>(`SELECT body FROM comment WHERE id = $1`, [s.commentId]),
      pool.query<{ body: string }>(`SELECT body FROM user_notification WHERE id = $1`, [s.notificationId]),
      pool.query<{ text: string }>(`SELECT text FROM agent_memory_chunk WHERE id = $1::uuid`, [s.memoryChunkId]),
    ]);
    for (const text of [c.rows[0].body, n.rows[0].body, m.rows[0].text]) {
      expect(text).toContain(`/__cm__/cue/${s.logicalA}`);
      expect(text).not.toContain(s.revA2);
    }
  });

  it.skipIf(!snapshot)("edges: two revisions of one logical cue collapse into a single row", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ entity_id: string; origin: string; created_at: Date }>(
      `SELECT entity_id, origin, created_at FROM wiki_entity_link
       WHERE wiki_id = $1::uuid AND entity_type = 'cue'
       ORDER BY origin, entity_id`,
      [s.wikiId],
    );
    // revA2 + revAshort（同 origin='wiki_body'）→ 一行；revBprefixed 的 manual 边
    // 指向另一个逻辑 cue 且 origin 不同，独立成行；悬空边原样保留。
    // 用 Set 比对：断言的是"哪三条边",不是行序（行序由 id 里的随机 tag 决定）。
    expect(new Set(rows.map(r => `${r.origin}:${r.entity_id}`))).toEqual(new Set([
      `manual:${s.logicalB}`,
      `wiki_body:${s.danglingEdgeId}`,
      `wiki_body:${s.logicalA}`,
    ]));
    expect(rows).toHaveLength(3);
    // 去重保留的是**最早**那条边的 created_at（边的"何时建立"是首次建立）。
    // 工厂写的是带 Z 的绝对时刻，比对不受服务器时区影响。
    const merged = rows.find(r => r.origin === "wiki_body" && r.entity_id === s.logicalA)!;
    expect(merged.created_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it.skipIf(!snapshot)("the scene edge sharing a revision id is untouched", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ entity_id: string }>(
      `SELECT entity_id FROM wiki_entity_link
       WHERE wiki_id = $1::uuid AND entity_type = 'scene'`,
      [s.wikiId],
    );
    expect(rows.map(r => r.entity_id)).toEqual([s.revA2]);
  });

  it.skipIf(!snapshot)("pre-migration text is recoverable from the backup table", async () => {
    const s = snapshot!;
    const { rows } = await getPool().query<{ body: string }>(
      `SELECT body FROM cue_mention_text_backup
       WHERE table_name = 'wiki' AND row_id = $1 AND column_name = 'body'`,
      [s.wikiId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain(`/__cm__/cue/${s.revA2}`);
  });
});
