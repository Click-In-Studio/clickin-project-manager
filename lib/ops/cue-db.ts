/**
 * Cue 本体（cue / cue_version 表）数据层。
 *
 * 一条 cue 锚在剧本块的 snapshot 上：读写、按 cue 表 / 项目列出、CoW 修订（同一
 * cue 在不同版本上分叉）、以及剧本块被删 / 改内容时的锚点漂移（handleBlockDeleted /
 * handleBlockContentChanged，由剧本写路径在 flush / patch 后调用）。末尾是工作区
 * 首页用的跨项目告警统计。
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
// For the initial migration: snapshot_id = block_id. After CoW, lookup is needed.
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
 *  入参是**稳定 cue_id**（#302 换锚后引用侧一律持它）；一个逻辑 cue 的多条修订
 *  同属一张 list（cowCue 逐字继承 cue_list_id），故 LIMIT 1 取哪条都一样。 */
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

let _cueSeq = 0;
const newCueId = () => `cue${Date.now().toString(36)}${(++_cueSeq).toString(36)}`;

export async function updateCue(
  id: string, cueListId: string,
  fields: { number?: string; name?: string; content?: string; start?: CueAnchor; end?: CueAnchor; warning?: boolean },
  versionId?: string
): Promise<void> {
  // Resolve anchors outside transaction (async DB lookups)
  const resolvedStart = fields.start !== undefined ? await anchorToDb(fields.start, versionId) : undefined;
  const resolvedEnd   = fields.end   !== undefined ? await anchorToDb(fields.end,   versionId) : undefined;

  const buildInPlaceUpdate = () => {
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
    return { sets, vals };
  };

  if (!versionId) {
    const { sets, vals } = buildInPlaceUpdate();
    if (!sets.length) return;
    await getPool().query(`UPDATE cue SET ${sets.join(", ")} WHERE id = $1 AND cue_list_id = $2`, vals);
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [versionId]);
    const refRes = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [id]
    );
    const refCount = parseInt(refRes.rows[0].count, 10);

    if (refCount <= 1) {
      const { sets, vals } = buildInPlaceUpdate();
      if (sets.length) await client.query(`UPDATE cue SET ${sets.join(", ")} WHERE id = $1 AND cue_list_id = $2`, vals);
    } else {
      // CoW: fork a new physical row for versionId（共享修订属于遗留多版本数据，只读保护）
      const curRes = await client.query<{
        number: string; name: string; content: string; warning: boolean; cue_id: string | null;
        start_kind: string; start_snapshot_id: string | null; start_offset: number | null;
        end_kind: string; end_snapshot_id: string | null; end_offset: number | null;
      }>(
        `SELECT number, name, content, warning, cue_id,
                start_kind, start_snapshot_id, start_offset,
                end_kind, end_snapshot_id, end_offset
         FROM cue WHERE id = $1 AND cue_list_id = $2`,
        [id, cueListId]
      );
      if (!curRes.rows.length) { await client.query("ROLLBACK"); return; }
      const cur = curRes.rows[0];

      const newId = newCueId();
      await client.query(
        `INSERT INTO cue (id, cue_id, cue_list_id, number, name, content,
           start_kind, start_snapshot_id, start_offset,
           end_kind,   end_snapshot_id,   end_offset, warning)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          newId, cur.cue_id ?? id, cueListId,
          fields.number  !== undefined ? fields.number  : cur.number,
          fields.name    !== undefined ? fields.name    : cur.name,
          fields.content !== undefined ? fields.content : cur.content,
          resolvedStart ? resolvedStart.kind       : cur.start_kind,
          resolvedStart ? resolvedStart.snapshotId : cur.start_snapshot_id,
          resolvedStart ? resolvedStart.offset     : cur.start_offset,
          resolvedEnd   ? resolvedEnd.kind         : cur.end_kind,
          resolvedEnd   ? resolvedEnd.snapshotId   : cur.end_snapshot_id,
          resolvedEnd   ? resolvedEnd.offset       : cur.end_offset,
          fields.warning !== undefined ? fields.warning : cur.warning,
        ]
      );

      // Remap cue_version for versionId only（线性化后 head 无子孙，不存在级联目标）
      await client.query(
        "UPDATE cue_version SET revision_id = $1 WHERE revision_id = $2 AND version_id = $3",
        [newId, id, versionId]
      );
      // （挂载边 CoW 复制已随 #420 退役：node_mount 锚稳定 cue_id）
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteCue(id: string, cueListId: string, versionId?: string): Promise<void> {
  if (!versionId) {
    await getPool().query("DELETE FROM cue WHERE id = $1 AND cue_list_id = $2", [id, cueListId]);
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Remove cue_version for versionId only（线性化后 head 无子孙）
    await client.query(
      "DELETE FROM cue_version WHERE revision_id = $1 AND version_id = $2",
      [id, versionId]
    );
    // Delete the physical row only if no version references it anymore
    const refRes = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [id]
    );
    if (parseInt(refRes.rows[0].count, 10) === 0) {
      await client.query("DELETE FROM cue WHERE id = $1 AND cue_list_id = $2", [id, cueListId]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── CoW helper: fork a cue revision for a version and remap cue_version ──────

type CueFullRow = {
  id: string; cue_id: string | null; cue_list_id: string;
  number: string; name: string; content: string; warning: boolean;
  start_kind: string; start_snapshot_id: string | null; start_offset: number | null;
  end_kind: string; end_snapshot_id: string | null; end_offset: number | null;
};

/** Insert a new physical cue row that is a copy of `cur` with `patch` applied,
 *  then remap cue_version for `versionId` from old to new id.
 *  Must be called inside an open transaction on `client`. Returns the new revision id. */
async function cowCue(
  client: PoolClient,
  versionId: string,
  cur: CueFullRow,
  patch: Partial<Pick<CueFullRow, "start_kind"|"start_snapshot_id"|"start_offset"|
                                  "end_kind"|"end_snapshot_id"|"end_offset"|"warning">>
): Promise<string> {
  const newId = newCueId();
  await client.query(
    `INSERT INTO cue (id, cue_id, cue_list_id, number, name, content,
       start_kind, start_snapshot_id, start_offset,
       end_kind,   end_snapshot_id,   end_offset, warning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      newId, cur.cue_id ?? cur.id, cur.cue_list_id, cur.number, cur.name, cur.content,
      patch.start_kind        ?? cur.start_kind,
      patch.start_snapshot_id ?? cur.start_snapshot_id,
      patch.start_offset      !== undefined ? patch.start_offset : cur.start_offset,
      patch.end_kind          ?? cur.end_kind,
      patch.end_snapshot_id   ?? cur.end_snapshot_id,
      patch.end_offset        !== undefined ? patch.end_offset : cur.end_offset,
      patch.warning           !== undefined ? patch.warning : cur.warning,
    ]
  );
  await client.query(
    "UPDATE cue_version SET revision_id = $1 WHERE revision_id = $2 AND version_id = $3",
    [newId, cur.id, versionId]
  );
  // （挂载边 CoW 复制已随 #420 退役：node_mount 锚稳定 cue_id）
  return newId;
}

/** Apply `patch` to a cue revision with CoW if the revision is shared.
 *  Returns the (possibly new) revision id. */
async function applyPatchWithCow(
  client: PoolClient,
  versionId: string,
  cur: CueFullRow,
  patch: Parameters<typeof cowCue>[3]
): Promise<string> {
  const refRes = await client.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [cur.id]
  );
  if (parseInt(refRes.rows[0].count, 10) <= 1) {
    // Single reference — update in place
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.start_kind        !== undefined) { sets.push(`start_kind=$${vals.push(patch.start_kind)}`); }
    if (patch.start_snapshot_id !== undefined) { sets.push(`start_snapshot_id=$${vals.push(patch.start_snapshot_id)}`); }
    if ("start_offset" in patch) { sets.push(`start_offset=$${vals.push(patch.start_offset ?? null)}`); }
    if (patch.end_kind          !== undefined) { sets.push(`end_kind=$${vals.push(patch.end_kind)}`); }
    if (patch.end_snapshot_id   !== undefined) { sets.push(`end_snapshot_id=$${vals.push(patch.end_snapshot_id)}`); }
    if ("end_offset" in patch) { sets.push(`end_offset=$${vals.push(patch.end_offset ?? null)}`); }
    if (patch.warning !== undefined) { sets.push(`warning=$${vals.push(patch.warning)}`); }
    if (sets.length) {
      vals.push(cur.id);
      await client.query(`UPDATE cue SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
    }
    return cur.id;
  }
  return cowCue(client, versionId, cur, patch);
}

/** Remove a cue revision from a version with CoW semantics.
 *  Must be called inside an open transaction. */
async function removeCueFromVersion(
  client: PoolClient,
  versionId: string,
  revisionId: string
): Promise<void> {
  const refRes = await client.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM cue_version WHERE revision_id = $1", [revisionId]
  );
  if (parseInt(refRes.rows[0].count, 10) <= 1) {
    await client.query("DELETE FROM cue WHERE id = $1", [revisionId]);
  } else {
    await client.query(
      "DELETE FROM cue_version WHERE revision_id = $1 AND version_id = $2",
      [revisionId, versionId]
    );
  }
}

/**
 * Called when a snapshot is deleted from a version.
 * Re-anchors (or removes) cue revisions in the affected version with CoW semantics.
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
        // Deleted block was the only one — remove the cue from this version
        await removeCueFromVersion(client, versionId, cur.id);
        continue;
      }

      const patch: Parameters<typeof cowCue>[3] = { warning: true };
      if (startHit) {
        if (prevSnapshotId) { patch.start_kind = "gap";   patch.start_snapshot_id = prevSnapshotId; patch.start_offset = null; }
        else                { patch.start_kind = "block"; patch.start_snapshot_id = nextSnapshotId!; patch.start_offset = 0; }
      }
      if (endHit) {
        if (prevSnapshotId) { patch.end_kind = "gap";   patch.end_snapshot_id = prevSnapshotId; patch.end_offset = null; }
        else                { patch.end_kind = "block"; patch.end_snapshot_id = nextSnapshotId!; patch.end_offset = 0; }
      }
      await applyPatchWithCow(client, versionId, cur, patch);
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
 * Called when a snapshot's text content changes (and optionally gets a new snapshot id via CoW).
 * Adjusts cue offsets that reference oldSnapshotId, re-pointing to newSnapshotId.
 * Performs CoW on shared cue revisions.
 */
export async function handleBlockContentChanged(
  oldSnapshotId: string,
  newSnapshotId: string,  // equals oldSnapshotId when no block CoW occurred
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
    [oldSnapshotId, versionId]
  );
  if (!res.rows.length) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const row of res.rows) {
      const startInBlock = row.start_kind === "block" && row.start_snapshot_id === oldSnapshotId;
      const endInBlock   = row.end_kind   === "block" && row.end_snapshot_id   === oldSnapshotId;

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

      const snapshotChanged = oldSnapshotId !== newSnapshotId;
      const offsetChanged   = newStartOffset !== row.start_offset || newEndOffset !== row.end_offset;
      const warnChanged     = warn !== row.warning;
      if (!snapshotChanged && !offsetChanged && !warnChanged) continue;

      const patch: Parameters<typeof cowCue>[3] = { warning: warn };
      if (startInBlock) {
        patch.start_snapshot_id = newSnapshotId;
        patch.start_offset = newStartOffset ?? undefined;
      }
      if (endInBlock) {
        patch.end_snapshot_id = newSnapshotId;
        patch.end_offset = newEndOffset ?? undefined;
      }

      await applyPatchWithCow(client, versionId, row, patch);
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
