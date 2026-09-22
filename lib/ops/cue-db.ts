/**
 * Cue 本体（cue / cue_version 表）数据层。
 *
 * 一条 cue 锚在剧本块的 snapshot 上：读写、按 cue 表 / 项目列出、就地改写 / 物理删，
 * 以及剧本块被删 / 改内容时的锚点漂移（handleBlockDeleted / handleBlockContentChanged，
 * 由剧本写路径在 flush / patch 后调用）。末尾是工作区首页用的跨项目告警统计。
 *
 * 修订 copy-on-write 已随 #639 删除（同 #634 一笔债）：版本体系退役后 cue_version
 * 引用数恒为 1，「共享修订」只存在于不可见的遗留版本。cue 表仍有 id（行 id）与
 * cue_id（稳定逻辑 id）两栏——行 id 现在也稳定了，但对外引用一律锚 cue_id（#302）。
 *
 * cue 表本体与授权在 cue-list-db.ts；锚点算法（lcsAdjust / adjustBlockAnchor）是
 * 纯函数，在 cue-types.ts。
 */
import { getPool } from "../pg";
import type { PoolClient } from "pg";
import type { Cue, CueAnchor } from "./cue-types";
import { adjustBlockAnchor, lcsAdjust } from "./cue-types";

// After migration: start_block_id/end_block_id are renamed to start_snapshot_id/end_snapshot_id.
// The row also has start_block_id/end_block_id as computed aliases from the JOIN with script table.
type CueRow = {
  id: string; cue_id: string; cue_list_id: string; number: string; name: string; content: string;
  start_kind: string; start_snapshot_id: string | null; start_offset: number | null;
  end_kind: string;   end_snapshot_id: string | null;   end_offset: number | null;
  // Logical block IDs resolved by joining script table (may be null if snapshot deleted)
  start_block_id: string | null;
  end_block_id: string | null;
  warning: boolean;
};

function rowToCue(r: CueRow): Cue {
  const start: CueAnchor = r.start_kind === "gap"
    ? { kind: "gap", afterBlockId: r.start_block_id ?? null }
    : { kind: "block", blockId: r.start_block_id ?? r.start_snapshot_id ?? '', offset: r.start_offset! };
  const end: CueAnchor = r.end_kind === "gap"
    ? { kind: "gap", afterBlockId: r.end_block_id ?? null }
    : { kind: "block", blockId: r.end_block_id ?? r.end_snapshot_id ?? '', offset: r.end_offset! };
  return { id: r.id, cueId: r.cue_id, cueListId: r.cue_list_id, number: r.number, name: r.name, content: r.content, start, end, warning: r.warning };
}

// Resolve a CueAnchor to the snapshot_id stored in the DB.
// snapshot_id 与 block_id 不同名时（遗留多版本数据）需按 version 查 script_version。
async function anchorToDb(a: CueAnchor, versionId?: string): Promise<{ kind: string; snapshotId: string | null; offset: number | null }> {
  if (a.kind === "gap") {
    if (a.afterBlockId === null) return { kind: "gap", snapshotId: null, offset: null };
    if (versionId) {
      const res = await getPool().query<{ snapshot_id: string }>(
        "SELECT snapshot_id FROM script_version WHERE block_id = $1 AND version_id = $2 LIMIT 1",
        [a.afterBlockId, versionId]
      );
      return { kind: "gap", snapshotId: res.rows[0]?.snapshot_id ?? a.afterBlockId, offset: null };
    }
    return { kind: "gap", snapshotId: a.afterBlockId, offset: null };
  }
  if (versionId) {
    const res = await getPool().query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM script_version WHERE block_id = $1 AND version_id = $2 LIMIT 1",
      [a.blockId, versionId]
    );
    return { kind: "block", snapshotId: res.rows[0]?.snapshot_id ?? a.blockId, offset: a.offset };
  }
  return { kind: "block", snapshotId: a.blockId, offset: a.offset };
}

const CUE_SELECT = `
  SELECT c.id, c.cue_id, c.cue_list_id, c.number, c.name, c.content,
         c.start_kind, c.start_snapshot_id, c.start_offset,
         c.end_kind,   c.end_snapshot_id,   c.end_offset, c.warning,
         s_start.block_id AS start_block_id,
         s_end.block_id   AS end_block_id
  FROM cue c
  LEFT JOIN script s_start ON s_start.id = c.start_snapshot_id
  LEFT JOIN script s_end   ON s_end.id   = c.end_snapshot_id
`;

export async function getCue(id: string, cueListId: string): Promise<Cue | null> {
  const res = await getPool().query<CueRow>(
    `${CUE_SELECT} WHERE c.id = $1 AND c.cue_list_id = $2`,
    [id, cueListId]
  );
  return res.rows.length ? rowToCue(res.rows[0]) : null;
}

/** cue → 所属 cue_list（production 归属校验内含）。cue 级权限门都长在 cue_list 上，
 *  拿到宿主 list id 才能过门（wiki-refs 等只有 cueId 的入口用）。
 *  入参是**稳定 cue_id**（#302 换锚后引用侧一律持它）；遗留数据里一个逻辑 cue 可能
 *  仍有多条修订行，但同属一张 list，故 LIMIT 1 取哪条都一样。 */
export async function getCueListIdForCue(cueId: string, productionId: string): Promise<string | null> {
  const res = await getPool().query<{ cue_list_id: string }>(
    `SELECT c.cue_list_id FROM cue c
     JOIN cue_list cl ON cl.id = c.cue_list_id
     WHERE c.cue_id = $1 AND cl.production_id = $2
     LIMIT 1`,
    [cueId, productionId],
  );
  return res.rows[0]?.cue_list_id ?? null;
}

export async function listCues(cueListId: string, versionId?: string): Promise<Cue[]> {
  if (versionId) {
    const res = await getPool().query<CueRow>(
      `${CUE_SELECT}
       WHERE c.cue_list_id = $1
         AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = c.id AND cv.version_id = $2)
       ORDER BY c.number`,
      [cueListId, versionId]
    );
    return res.rows.map(rowToCue);
  }
  const res = await getPool().query<CueRow>(
    `${CUE_SELECT} WHERE c.cue_list_id = $1 ORDER BY c.number`,
    [cueListId]
  );
  return res.rows.map(rowToCue);
}

export async function listCuesByProduction(productionId: string, versionId?: string): Promise<Cue[]> {
  if (versionId) {
    const res = await getPool().query<CueRow>(
      `${CUE_SELECT}
       JOIN cue_list cl ON cl.id = c.cue_list_id
       WHERE cl.production_id = $1
         AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = c.id AND cv.version_id = $2)
       ORDER BY c.number`,
      [productionId, versionId]
    );
    return res.rows.map(rowToCue);
  }
  const res = await getPool().query<CueRow>(
    `${CUE_SELECT}
     JOIN cue_list cl ON cl.id = c.cue_list_id
     WHERE cl.production_id = $1
     ORDER BY c.number`,
    [productionId]
  );
  return res.rows.map(rowToCue);
}

export async function countWarningCues(cueListIds: string[]): Promise<number> {
  if (cueListIds.length === 0) return 0;
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM cue WHERE cue_list_id = ANY($1::text[]) AND warning = TRUE`,
    [cueListIds]
  );
  return parseInt(res.rows[0].count, 10);
}

export async function countCueWarningsForProduction(
  productionId: string,
  userId: string,
  isAdmin: boolean,
): Promise<number> {
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM cue c
     JOIN cue_list cl ON c.cue_list_id = cl.id
     WHERE cl.production_id = $1 AND c.warning = TRUE
       AND ($2 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = cl.production_id AND pm.user_id = $3
           AND pm.status = 'active'
       ))`,
    [productionId, isAdmin, userId]
  );
  return parseInt(res.rows[0].count, 10);
}

export async function createCue(data: {
  id: string; cueListId: string; number: string; name: string; content: string;
  start: CueAnchor; end: CueAnchor; versionId?: string;
}): Promise<void> {
  const s = await anchorToDb(data.start, data.versionId);
  const e = await anchorToDb(data.end, data.versionId);
  await getPool().query(
    `INSERT INTO cue (id, cue_id, cue_list_id, number, name, content,
       start_kind, start_snapshot_id, start_offset,
       end_kind,   end_snapshot_id,   end_offset)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [data.id, data.cueListId, data.number, data.name, data.content,
     s.kind, s.snapshotId, s.offset, e.kind, e.snapshotId, e.offset]
  );
  if (data.versionId) {
    await getPool().query(
      "INSERT INTO cue_version (revision_id, version_id, cue_id) VALUES ($1, $2, $1) ON CONFLICT DO NOTHING",
      [data.id, data.versionId]
    );
  }
}

export async function updateCue(
  id: string, cueListId: string,
  fields: { number?: string; name?: string; content?: string; start?: CueAnchor; end?: CueAnchor; warning?: boolean },
  versionId?: string
): Promise<void> {
  // 锚点解析要查库（blockId → snapshotId），先于 UPDATE 做
  const resolvedStart = fields.start !== undefined ? await anchorToDb(fields.start, versionId) : undefined;
  const resolvedEnd   = fields.end   !== undefined ? await anchorToDb(fields.end,   versionId) : undefined;

  const sets: string[] = [];
  const vals: unknown[] = [id, cueListId];
  if (fields.number  !== undefined) sets.push(`number  = $${vals.push(fields.number)}`);
  if (fields.name    !== undefined) sets.push(`name    = $${vals.push(fields.name)}`);
  if (fields.content !== undefined) sets.push(`content = $${vals.push(fields.content)}`);
  if (fields.warning !== undefined) sets.push(`warning = $${vals.push(fields.warning)}`);
  if (resolvedStart) {
    const s = resolvedStart;
    sets.push(`start_kind=$${vals.push(s.kind)}, start_snapshot_id=$${vals.push(s.snapshotId)}, start_offset=$${vals.push(s.offset)}`);
  }
  if (resolvedEnd) {
    const e = resolvedEnd;
    sets.push(`end_kind=$${vals.push(e.kind)}, end_snapshot_id=$${vals.push(e.snapshotId)}, end_offset=$${vals.push(e.offset)}`);
  }
  if (!sets.length) return;
  await getPool().query(`UPDATE cue SET ${sets.join(", ")} WHERE id = $1 AND cue_list_id = $2`, vals);
}

/** 物理删除一条 cue 修订行。cue_version 行随 `revision_id` 的 ON DELETE CASCADE 消失。 */
export async function deleteCue(id: string, cueListId: string): Promise<void> {
  await getPool().query("DELETE FROM cue WHERE id = $1 AND cue_list_id = $2", [id, cueListId]);
}

// ── 锚点漂移的行内改写 ───────────────────────────────────────────────────────

type CueFullRow = {
  id: string; cue_id: string | null; cue_list_id: string;
  number: string; name: string; content: string; warning: boolean;
  start_kind: string; start_snapshot_id: string | null; start_offset: number | null;
  end_kind: string; end_snapshot_id: string | null; end_offset: number | null;
};

type CuePatch = Partial<Pick<CueFullRow, "start_kind"|"start_snapshot_id"|"start_offset"|
                                         "end_kind"|"end_snapshot_id"|"end_offset"|"warning">>;

/** 就地把 `patch` 写进 cue 行。必须在 `client` 上已开的事务里调用。 */
async function applyCuePatch(client: PoolClient, id: string, patch: CuePatch): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.start_kind        !== undefined) { sets.push(`start_kind=$${vals.push(patch.start_kind)}`); }
  if (patch.start_snapshot_id !== undefined) { sets.push(`start_snapshot_id=$${vals.push(patch.start_snapshot_id)}`); }
  if ("start_offset" in patch) { sets.push(`start_offset=$${vals.push(patch.start_offset ?? null)}`); }
  if (patch.end_kind          !== undefined) { sets.push(`end_kind=$${vals.push(patch.end_kind)}`); }
  if (patch.end_snapshot_id   !== undefined) { sets.push(`end_snapshot_id=$${vals.push(patch.end_snapshot_id)}`); }
  if ("end_offset" in patch) { sets.push(`end_offset=$${vals.push(patch.end_offset ?? null)}`); }
  if (patch.warning !== undefined) { sets.push(`warning=$${vals.push(patch.warning)}`); }
  if (!sets.length) return;
  vals.push(id);
  await client.query(`UPDATE cue SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
}

/**
 * 剧本块被删时调用：把锚在该 snapshot 上的 cue 重锚到前 / 后块（并置 warning），
 * 整份剧本被删空时连 cue 行一并物理删。
 */
export async function handleBlockDeleted(
  deletedSnapshotId: string,
  prevSnapshotId: string | null,
  nextSnapshotId: string | null,
  versionId: string,
): Promise<void> {
  // Find cues in this version anchoring to the deleted snapshot
  const affected = await getPool().query<CueFullRow>(
    `SELECT cue.id, cue.cue_id, cue.cue_list_id, cue.number, cue.name, cue.content, cue.warning,
            cue.start_kind, cue.start_snapshot_id, cue.start_offset,
            cue.end_kind,   cue.end_snapshot_id,   cue.end_offset
     FROM cue
     WHERE (start_snapshot_id = $1 OR end_snapshot_id = $1)
       AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = cue.id AND cv.version_id = $2)`,
    [deletedSnapshotId, versionId]
  );
  if (!affected.rows.length) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const cur of affected.rows) {
      const startHit = cur.start_snapshot_id === deletedSnapshotId;
      const endHit   = cur.end_snapshot_id   === deletedSnapshotId;

      if (!prevSnapshotId && !nextSnapshotId) {
        // 删掉的是唯一一个块——cue 无处可锚，物理删
        await client.query("DELETE FROM cue WHERE id = $1", [cur.id]);
        continue;
      }

      const patch: CuePatch = { warning: true };
      if (startHit) {
        if (prevSnapshotId) { patch.start_kind = "gap";   patch.start_snapshot_id = prevSnapshotId; patch.start_offset = null; }
        else                { patch.start_kind = "block"; patch.start_snapshot_id = nextSnapshotId!; patch.start_offset = 0; }
      }
      if (endHit) {
        if (prevSnapshotId) { patch.end_kind = "gap";   patch.end_snapshot_id = prevSnapshotId; patch.end_offset = null; }
        else                { patch.end_kind = "block"; patch.end_snapshot_id = nextSnapshotId!; patch.end_offset = 0; }
      }
      await applyCuePatch(client, cur.id, patch);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 剧本块内容改变时调用：按 LCS 把锚在该 snapshot 上的 cue 偏移量挪到新位置并置 warning。
 * snapshot id 就地稳定（块 CoW 已随 #634 退役），故只动偏移量。
 */
export async function handleBlockContentChanged(
  snapshotId: string,
  oldContent: string,
  newContent: string,
  versionId: string,
): Promise<void> {
  if (oldContent === newContent) return;

  const res = await getPool().query<CueFullRow>(
    `SELECT cue.id, cue.cue_id, cue.cue_list_id, cue.number, cue.name, cue.content, cue.warning,
            cue.start_kind, cue.start_snapshot_id, cue.start_offset,
            cue.end_kind,   cue.end_snapshot_id,   cue.end_offset
     FROM cue
     WHERE ((start_kind='block' AND start_snapshot_id=$1)
        OR  (end_kind='block'   AND end_snapshot_id=$1))
       AND EXISTS (SELECT 1 FROM cue_version cv WHERE cv.revision_id = cue.id AND cv.version_id = $2)`,
    [snapshotId, versionId]
  );
  if (!res.rows.length) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const row of res.rows) {
      const startInBlock = row.start_kind === "block" && row.start_snapshot_id === snapshotId;
      const endInBlock   = row.end_kind   === "block" && row.end_snapshot_id   === snapshotId;

      let newStartOffset = row.start_offset;
      let newEndOffset   = row.end_offset;
      let warn = row.warning;

      if (startInBlock && endInBlock) {
        const result = adjustBlockAnchor(oldContent, newContent, row.start_offset!, row.end_offset!);
        newStartOffset = result.startOffset;
        newEndOffset   = result.endOffset;
      } else {
        if (startInBlock) newStartOffset = lcsAdjust(oldContent, newContent, row.start_offset!);
        if (endInBlock)   newEndOffset   = lcsAdjust(oldContent, newContent, row.end_offset!);
      }
      warn = true; // any automatic position adjustment warrants review

      const offsetChanged = newStartOffset !== row.start_offset || newEndOffset !== row.end_offset;
      const warnChanged   = warn !== row.warning;
      if (!offsetChanged && !warnChanged) continue;

      const patch: CuePatch = { warning: warn };
      if (startInBlock) patch.start_offset = newStartOffset ?? undefined;
      if (endInBlock)   patch.end_offset   = newEndOffset ?? undefined;

      await applyCuePatch(client, row.id, patch);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
// ── 跨项目 cue 告警（工作区首页 / 我的公告页）──────────────────────────────

export type CueWarningEntry = {
  id: string;
  cueListId: string;
  cueListAbbr: string;
  number: string;
  name: string;
  productionId: string;
  productionName: string;
  startKind: "block" | "gap";
  endKind: "block" | "gap";
  warningType: "orphaned" | "adjusted";
};

export async function listCueWarningsForUser(
  userId: string,
  isAdmin: boolean,
): Promise<CueWarningEntry[]> {
  const res = await getPool().query<{
    id: string; cue_list_id: string; cue_list_abbr: string;
    number: string; name: string; production_id: string; production_name: string;
    start_kind: string; end_kind: string;
  }>(
    `SELECT c.id, c.cue_list_id, cl.abbr AS cue_list_abbr,
            c.number, c.name, cl.production_id, p.name AS production_name,
            c.start_kind, c.end_kind
     FROM cue c
     JOIN cue_list cl ON c.cue_list_id = cl.id
     JOIN production p ON cl.production_id = p.id
     WHERE c.warning = TRUE
       AND p.archived_at IS NULL
       AND ($1 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = cl.production_id AND pm.user_id = $2
           AND pm.status = 'active'
       ))
     ORDER BY p.name, cl.abbr, c.number`,
    [isAdmin, userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    cueListId: r.cue_list_id,
    cueListAbbr: r.cue_list_abbr,
    number: r.number,
    name: r.name,
    productionId: r.production_id,
    productionName: r.production_name,
    startKind: r.start_kind as "block" | "gap",
    endKind: r.end_kind as "block" | "gap",
    warningType: (r.start_kind === "gap" || r.end_kind === "gap") ? "orphaned" : "adjusted",
  }));
}

export async function countCueWarningsForUser(
  userId: string,
  isAdmin: boolean,
): Promise<number> {
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM cue c
     JOIN cue_list cl ON c.cue_list_id = cl.id
     JOIN production p ON cl.production_id = p.id
     WHERE c.warning = TRUE
       AND p.archived_at IS NULL
       AND ($1 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = cl.production_id AND pm.user_id = $2
           AND pm.status = 'active'
       ))`,
    [isAdmin, userId],
  );
  return parseInt(res.rows[0].count, 10);
}
