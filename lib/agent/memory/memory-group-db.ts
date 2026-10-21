import type { PoolClient } from "pg";
import { getPool } from "@/lib/pg";
import { connectedComponents } from "./memory-graph";
import {
  memoryId,
  memoryTransaction,
  MemoryAccessError,
  MemoryConflictError,
  MemoryValidationError,
  checkMemoryOrigin,
  requireMemoryAccess,
} from "./memory-access-db";
import {
  MEMORY_CACHE_SAFE,
  MEMORY_CACHE_TRIGGER,
  MEMORY_GROUP_BRIEF_MAX,
  type MemoryGroup,
  type MemoryRelation,
  type MemoryEntry,
} from "./memory-types";

export type EntryRow = {
  id: string;
  group_id: string | null;
  body: string;
  brief: string;
  source: "active";
  user_edited: boolean;
  revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};
export function memoryEntry(row: EntryRow): MemoryEntry {
  return {
    id: row.id,
    groupId: row.group_id,
    body: row.body,
    brief: row.brief,
    source: row.source,
    userEdited: row.user_edited,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}
export type GroupRow = {
  id: string;
  scope_id: string;
  member_count: number;
  context_chars: number;
  in_cache: boolean;
  last_touched_at: Date;
  revision: string;
  summary: string | null;
  summary_revision: string | null;
};
export type RelationRow = {
  id: string;
  left_entry_id: string;
  right_entry_id: string;
  kind: "duplicate" | "conflict";
  reason: string;
  created_at: Date;
};
export function memoryRelation(row: RelationRow): MemoryRelation {
  return {
    id: row.id,
    leftId: row.left_entry_id,
    rightId: row.right_entry_id,
    kind: row.kind,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  };
}

export async function refreshGroup(
  client: PoolClient,
  scopeId: string,
  groupId: string,
): Promise<void> {
  const stats = (
    await client.query<{ n: number; chars: number }>(
      "SELECT count(*)::int n,COALESCE(sum(length(brief)+400),0)::int chars FROM agent_memory_entry WHERE scope_id=$1 AND group_id=$2 AND deleted_at IS NULL",
      [scopeId, groupId],
    )
  ).rows[0];
  if (!stats.n) {
    await client.query(
      "DELETE FROM agent_memory_group WHERE scope_id=$1 AND id=$2",
      [scopeId, groupId],
    );
    return;
  }
  const edgeSize = Number(
    (
      await client.query<{ chars: string }>(
        "SELECT COALESCE(sum(length(r.reason)+200),0) chars FROM agent_memory_relation r JOIN agent_memory_entry e ON e.scope_id=r.scope_id AND e.id=r.left_entry_id WHERE r.scope_id=$1 AND e.group_id=$2 AND r.resolved_at IS NULL",
        [scopeId, groupId],
      )
    ).rows[0].chars,
  );
  await client.query(
    "UPDATE agent_memory_group SET member_count=$3,context_chars=$4,revision=revision+1,summary=NULL,summary_revision=NULL WHERE scope_id=$1 AND id=$2",
    [scopeId, groupId, stats.n, stats.chars + edgeSize],
  );
}

/** 删除节点/边后只遍历受影响的旧组；不是全用户重建。 */
export async function splitGroup(
  client: PoolClient,
  scopeId: string,
  groupId: string,
): Promise<void> {
  const group = (
    await client.query<GroupRow>(
      "SELECT * FROM agent_memory_group WHERE scope_id=$1 AND id=$2",
      [scopeId, groupId],
    )
  ).rows[0];
  if (!group) return;
  const nodes = (
    await client.query<{ id: string }>(
      "SELECT id FROM agent_memory_entry WHERE scope_id=$1 AND group_id=$2 AND deleted_at IS NULL ORDER BY id",
      [scopeId, groupId],
    )
  ).rows;
  const edges = (
    await client.query<RelationRow>(
      `SELECT r.* FROM agent_memory_relation r JOIN agent_memory_entry e ON e.id=r.left_entry_id AND e.scope_id=r.scope_id WHERE r.scope_id=$1 AND e.group_id=$2 AND r.resolved_at IS NULL`,
      [scopeId, groupId],
    )
  ).rows;
  const components = connectedComponents(
    nodes.map((n) => n.id),
    edges.map((r) => ({ leftId: r.left_entry_id, rightId: r.right_entry_id })),
  ).sort((a, b) => b.length - a.length);
  for (const component of components.slice(1)) {
    const id = memoryId();
    await client.query(
      "INSERT INTO agent_memory_group(id,scope_id,in_cache,last_touched_at) VALUES($1,$2,$3,$4)",
      [id, scopeId, group.in_cache, group.last_touched_at],
    );
    await client.query(
      "UPDATE agent_memory_entry SET group_id=$3 WHERE scope_id=$1 AND id=ANY($2::text[])",
      [scopeId, component, id],
    );
    await refreshGroup(client, scopeId, id);
  }
  await refreshGroup(client, scopeId, groupId);
}

export type RelationInput = {
  leftId: string;
  rightId: string;
  kind: "duplicate" | "conflict";
  reason: string;
};
export async function linkInTx(
  client: PoolClient,
  scopeId: string,
  input: RelationInput,
): Promise<boolean> {
  if (
    !input.reason.trim() ||
    input.reason.length > 500 ||
    input.leftId === input.rightId ||
    !["duplicate", "conflict"].includes(input.kind)
  )
    throw new MemoryValidationError("无效记忆关系");
  const ids = [input.leftId, input.rightId].sort();
  const nodes = (
    await client.query<{ id: string; group_id: string; revision: string }>(
      "SELECT id,group_id,revision FROM agent_memory_entry WHERE scope_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL",
      [scopeId, ids],
    )
  ).rows;
  if (nodes.length !== 2)
    throw new MemoryAccessError("关系两端必须是同一范围内的有效记忆");
  const inserted = await client.query(
    `INSERT INTO agent_memory_relation(id,scope_id,left_entry_id,right_entry_id,kind,reason,left_revision,right_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(scope_id,left_entry_id,right_entry_id) DO UPDATE SET kind=EXCLUDED.kind,reason=EXCLUDED.reason,
    left_revision=EXCLUDED.left_revision,right_revision=EXCLUDED.right_revision,resolved_at=NULL,created_at=clock_timestamp()
    WHERE agent_memory_relation.resolved_at IS NOT NULL AND (agent_memory_relation.left_revision<>EXCLUDED.left_revision OR agent_memory_relation.right_revision<>EXCLUDED.right_revision)`,
    [
      memoryId(),
      scopeId,
      ...ids,
      input.kind,
      input.reason,
      ...ids.map((id) => nodes.find((n) => n.id === id)!.revision),
    ],
  );
  if (!inserted.rowCount) return false;
  const groups = (
    await client.query<GroupRow>(
      "SELECT * FROM agent_memory_group WHERE scope_id=$1 AND id=ANY($2::text[]) ORDER BY member_count DESC,id",
      [scopeId, nodes.map((n) => n.group_id)],
    )
  ).rows;
  const target = groups[0].id;
  if (groups.length === 2) {
    await client.query(
      "UPDATE agent_memory_entry SET group_id=$3 WHERE scope_id=$1 AND group_id=$2",
      [scopeId, groups[1].id, target],
    );
    await client.query(
      "DELETE FROM agent_memory_group WHERE scope_id=$1 AND id=$2",
      [scopeId, groups[1].id],
    );
  }
  // 合组统计直接相加；新增组内边也只加这一条边的开销，不重扫大组。
  const members = groups.reduce((n, g) => n + g.member_count, 0);
  const chars =
    groups.reduce((n, g) => n + g.context_chars, 0) + input.reason.length + 200;
  await client.query(
    "UPDATE agent_memory_group SET member_count=$3,context_chars=$4,revision=revision+1,summary=NULL,summary_revision=NULL,in_cache=true,last_touched_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
    [scopeId, target, members, chars],
  );
  return true;
}

export async function addMemoryRelations(
  userId: string,
  productionId: string | null,
  relations: RelationInput[],
  expected?: Record<string, number>,
): Promise<void> {
  if (relations.length > 100)
    throw new MemoryValidationError("每批最多100条关系");
  await memoryTransaction(userId, productionId, async (client, scope) => {
    if (expected) {
      const rows = (
        await client.query<{ id: string; revision: string }>(
          "SELECT id,revision FROM agent_memory_entry WHERE scope_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL",
          [scope.id, Object.keys(expected)],
        )
      ).rows;
      if (
        rows.length !== Object.keys(expected).length ||
        rows.some((r) => Number(r.revision) !== expected[r.id])
      )
        throw new MemoryConflictError("整理输入已变化");
      if (
        relations.some(
          (r) =>
            expected[r.leftId] === undefined ||
            expected[r.rightId] === undefined,
        )
      )
        throw new MemoryValidationError("关系包含未提供给整理器的条目");
    }
    let changed = false;
    for (const relation of relations)
      changed = (await linkInTx(client, scope.id, relation)) || changed;
    if (changed)
      await client.query(
        "UPDATE agent_memory_scope SET revision=revision+1 WHERE id=$1",
        [scope.id],
      );
  });
}

/** 高水位由调用方先安排整理，整理后再按整组回落；touch 不改变内容修订。 */
export async function evictInTx(
  client: PoolClient,
  scopeId: string,
  safe = MEMORY_CACHE_SAFE,
  trigger = MEMORY_CACHE_TRIGGER,
): Promise<string[]> {
  if (
    !Number.isSafeInteger(safe) ||
    safe < 0 ||
    !Number.isSafeInteger(trigger) ||
    trigger <= safe
  )
    throw new MemoryValidationError("缓存水位需要0≤A<B");
  const groups = (
    await client.query<GroupRow>(
      "SELECT * FROM agent_memory_group WHERE scope_id=$1 AND in_cache ORDER BY last_touched_at DESC,id",
      [scopeId],
    )
  ).rows;
  if (groups.reduce((n, g) => n + g.member_count, 0) < trigger) return [];
  let count = 0;
  const evicted: string[] = [];
  let full = false;
  for (const group of groups) {
    if (full || count + group.member_count > safe) {
      full = true;
      evicted.push(group.id);
    } else count += group.member_count;
  }
  if (evicted.length)
    await client.query(
      "UPDATE agent_memory_group SET in_cache=false WHERE scope_id=$1 AND id=ANY($2::text[])",
      [scopeId, evicted],
    );
  return evicted;
}
export async function evictMemoryCache(
  userId: string,
  productionId: string | null,
  safe = MEMORY_CACHE_SAFE,
  trigger = MEMORY_CACHE_TRIGGER,
): Promise<string[]> {
  return memoryTransaction(userId, productionId, (c, s) =>
    evictInTx(c, s.id, safe, trigger),
  );
}
export async function touchMemory(
  userId: string,
  productionId: string | null,
  ids: string[],
  runId?: string,
): Promise<void> {
  if (!ids.length || ids.length > 50)
    throw new MemoryValidationError("touch需要1—50个条目");
  await memoryTransaction(userId, productionId, async (c, s) => {
    await checkMemoryOrigin(c, userId, productionId, runId);
    const rows = (
      await c.query<{ group_id: string }>(
        "SELECT group_id FROM agent_memory_entry WHERE scope_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL",
        [s.id, [...new Set(ids)]],
      )
    ).rows;
    if (rows.length !== new Set(ids).size)
      throw new MemoryAccessError("记忆不存在或不属于这个范围");
    await c.query(
      "UPDATE agent_memory_group SET in_cache=true,last_touched_at=clock_timestamp() WHERE scope_id=$1 AND id=ANY($2::text[])",
      [s.id, [...new Set(rows.map((r) => r.group_id))]],
    );
  });
}

export async function readGroupsInTx(
  c: PoolClient,
  scopeId: string,
  ids: string[],
  full = false,
): Promise<MemoryGroup[]> {
  const groups = (
    await c.query<GroupRow>(
      "SELECT * FROM agent_memory_group WHERE scope_id=$1 AND id=ANY($2::text[]) ORDER BY id",
      [scopeId, ids],
    )
  ).rows;
  const result: MemoryGroup[] = [];
  for (const g of groups) {
    const oversized = g.context_chars > MEMORY_GROUP_BRIEF_MAX;
    const fresh = g.summary !== null && g.summary_revision === g.revision;
    const entries =
      !oversized || full
        ? (
            await c.query<EntryRow>(
              `SELECT id,group_id,brief,${full ? "body" : "''::text AS body"},source,user_edited,revision,created_at,updated_at,deleted_at FROM agent_memory_entry WHERE scope_id=$1 AND group_id=$2 AND deleted_at IS NULL ORDER BY created_at,id`,
              [scopeId, g.id],
            )
          ).rows.map(memoryEntry)
        : [];
    const relations =
      !oversized || full
        ? (
            await c.query<RelationRow>(
              "SELECT r.* FROM agent_memory_relation r JOIN agent_memory_entry e ON e.scope_id=r.scope_id AND e.id=r.left_entry_id WHERE r.scope_id=$1 AND e.group_id=$2 AND r.resolved_at IS NULL ORDER BY r.id",
              [scopeId, g.id],
            )
          ).rows.map(memoryRelation)
        : [];
    result.push({
      id: g.id,
      revision: Number(g.revision),
      memberCount: g.member_count,
      inCache: g.in_cache,
      lastTouchedAt: g.last_touched_at.toISOString(),
      summary: oversized && fresh ? g.summary : null,
      summaryPending: oversized && !fresh,
      entries,
      relations,
    });
  }
  return result;
}
export async function readMemoryGroups(
  userId: string,
  productionId: string | null,
  entryIds?: string[],
): Promise<MemoryGroup[]> {
  return memoryTransaction(userId, productionId, async (c, s) => {
    const ids = entryIds
      ? (
          await c.query<{ group_id: string }>(
            "SELECT DISTINCT group_id FROM agent_memory_entry WHERE scope_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL",
            [s.id, entryIds],
          )
        ).rows.map((r) => r.group_id)
      : (
          await c.query<{ id: string }>(
            "SELECT id FROM agent_memory_group WHERE scope_id=$1 AND in_cache ORDER BY id",
            [s.id],
          )
        ).rows.map((r) => r.id);
    if (
      entryIds &&
      (
        await c.query(
          "SELECT id FROM agent_memory_entry WHERE scope_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL",
          [s.id, entryIds],
        )
      ).rowCount !== new Set(entryIds).size
    )
      throw new MemoryAccessError("记忆不存在或不属于这个范围");
    return readGroupsInTx(c, s.id, ids);
  });
}

export async function readGroupPage(
  userId: string,
  productionId: string | null,
  groupId: string,
  revision: number,
  offset: number,
): Promise<{ group: MemoryGroup; nextOffset: number | null; total: number }> {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new MemoryValidationError("offset需要非负整数");
  return memoryTransaction(userId, productionId, async (c, s) => {
    const g = (
      await c.query<GroupRow>(
        "SELECT * FROM agent_memory_group WHERE scope_id=$1 AND id=$2",
        [s.id, groupId],
      )
    ).rows[0];
    if (!g) throw new MemoryAccessError("记忆组不存在");
    if (Number(g.revision) !== revision)
      throw new MemoryConflictError("记忆组已变化，请重新读取概览");
    const page = (
      await c.query<EntryRow>(
        "SELECT * FROM agent_memory_entry WHERE scope_id=$1 AND group_id=$2 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 5 OFFSET $3",
        [s.id, groupId, offset],
      )
    ).rows;
    const relations = (
      await c.query<RelationRow>(
        "SELECT * FROM agent_memory_relation WHERE scope_id=$1 AND resolved_at IS NULL AND (left_entry_id=ANY($2::text[]) OR right_entry_id=ANY($2::text[])) ORDER BY id LIMIT 101",
        [s.id, page.map((e) => e.id)],
      )
    ).rows;
    if (relations.length > 100)
      throw new MemoryValidationError(
        "本页关联过多，请先分批整理该组；未返回孤立事实",
      );
    const group = (await readGroupsInTx(c, s.id, [groupId]))[0];
    group.entries = page.map(memoryEntry);
    group.relations = relations.map(memoryRelation);
    return {
      group,
      nextOffset:
        offset + page.length < g.member_count ? offset + page.length : null,
      total: g.member_count,
    };
  });
}

export async function commitGroupSummary(
  userId: string,
  productionId: string | null,
  groupId: string,
  revision: number,
  summary: string,
): Promise<boolean> {
  if (!summary.trim() || summary.length > 4000)
    throw new MemoryValidationError("摘要需要1—4000字符");
  return memoryTransaction(
    userId,
    productionId,
    async (c, s) =>
      (
        await c.query(
          "UPDATE agent_memory_group SET summary=$4,summary_revision=revision WHERE scope_id=$1 AND id=$2 AND revision=$3",
          [s.id, groupId, revision, summary],
        )
      ).rowCount === 1,
  );
}

export async function listMemoryScopes(): Promise<
  Array<{ userId: string; productionId: string | null }>
> {
  const rows = (
    await getPool().query<{ user_id: string; production_id: string | null }>(
      "SELECT s.user_id,s.production_id FROM agent_memory_scope s WHERE EXISTS(SELECT 1 FROM agent_memory_entry e WHERE e.scope_id=s.id AND e.deleted_at IS NULL)",
    )
  ).rows;
  const scopes = [];
  for (const r of rows) {
    try {
      await requireMemoryAccess(r.user_id, r.production_id);
      scopes.push({ userId: r.user_id, productionId: r.production_id });
    } catch (error) {
      if (!(error instanceof MemoryAccessError)) throw error;
    }
  }
  return scopes;
}
