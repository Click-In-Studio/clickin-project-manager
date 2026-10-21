import { getPool } from "@/lib/pg";
import type { PoolClient } from "pg";
import {
  MEMORY_ENTRY_MAX,
  MEMORY_BRIEF_MAX,
  type MemoryScopeView,
} from "./memory-types";
import {
  memoryId,
  memoryTransaction,
  checkMemoryOrigin,
  MemoryAccessError,
  MemoryConflictError,
  MemoryValidationError,
} from "./memory-access-db";
import {
  memoryEntry,
  refreshGroup,
  splitGroup,
  type EntryRow,
} from "./memory-group-db";
export {
  requireMemoryAccess,
  lockMemoryUser,
  MemoryAccessError,
  MemoryConflictError,
  MemoryValidationError,
} from "./memory-access-db";

export async function readMemoryScope(
  userId: string,
  productionId: string | null,
): Promise<MemoryScopeView> {
  return memoryTransaction(userId, productionId, async (c, s) => {
    const entries = (
      await c.query<EntryRow>(
        "SELECT * FROM agent_memory_entry WHERE scope_id=$1 ORDER BY created_at,id",
        [s.id],
      )
    ).rows.map(memoryEntry);
    return {
      productionId,
      revision: Number(s.revision),
      historyCutoff: s.history_cutoff?.toISOString() ?? null,
      entries: entries.filter((e) => !e.deletedAt),
      deletedEntries: entries.filter((e) => e.deletedAt),
    };
  });
}
export async function listMemoryProjects(
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  return (
    await getPool().query<{ id: string; name: string }>(
      `SELECT p.id,p.name FROM production p WHERE p.owner_id=$1 OR EXISTS
    (SELECT 1 FROM production_member m WHERE m.production_id=p.id AND m.user_id=$1 AND m.status='active') ORDER BY p.name,p.id`,
      [userId],
    )
  ).rows;
}
export type MemoryMutation = {
  action: "create" | "update" | "delete" | "restore";
  id?: string;
  body?: string;
  brief?: string;
  revision?: number;
  actor: "user" | "agent";
  runId?: string;
};
export function validateMemoryText(body: string, brief: string): void {
  if (!body.trim() || body.length > MEMORY_ENTRY_MAX)
    throw new MemoryValidationError(`记忆正文需要1—${MEMORY_ENTRY_MAX}字符`);
  if (!brief.trim() || brief.length > MEMORY_BRIEF_MAX)
    throw new MemoryValidationError(`记忆brief需要1—${MEMORY_BRIEF_MAX}字符`);
}
export async function mutateEntryInTx(
  c: PoolClient,
  scopeId: string,
  input: MemoryMutation,
): Promise<string> {
  const old =
    input.action === "create"
      ? null
      : (
          await c.query<EntryRow>(
            "SELECT * FROM agent_memory_entry WHERE scope_id=$1 AND id=$2",
            [scopeId, input.id],
          )
        ).rows[0];
  if (input.action !== "create" && !old)
    throw new MemoryAccessError("记忆不存在或不属于这个范围");
  if (old && Number(old.revision) !== input.revision)
    throw new MemoryConflictError("记忆已变化，请重新加载后再修改");
  if (old && (input.action === "restore") !== !!old.deleted_at)
    throw new MemoryConflictError("记忆状态已变化");
  if (
    input.actor === "agent" &&
    (old?.user_edited || input.action === "restore")
  )
    throw new MemoryAccessError("用户编辑条目及恢复操作由用户管理");
  const id = old?.id ?? memoryId();
  if (input.action === "delete") {
    await c.query(
      "DELETE FROM agent_memory_relation WHERE scope_id=$1 AND (left_entry_id=$2 OR right_entry_id=$2)",
      [scopeId, id],
    );
    await c.query(
      "UPDATE agent_memory_entry SET deleted_at=clock_timestamp(),group_id=NULL,revision=revision+1,updated_at=clock_timestamp(),embedding=NULL,embedding_revision=NULL WHERE scope_id=$1 AND id=$2",
      [scopeId, id],
    );
    await splitGroup(c, scopeId, old!.group_id!);
    return id;
  }
  const body =
    input.action === "restore" ? old!.body : (input.body?.trim() ?? "");
  const brief =
    input.action === "restore"
      ? old!.brief
      : (input.brief?.trim() ??
        (input.actor === "user"
          ? body.slice(0, MEMORY_BRIEF_MAX)
          : (old?.brief ?? body.slice(0, MEMORY_BRIEF_MAX))));
  if (input.actor === "agent" && old && body !== old.body && !input.brief) {
    throw new MemoryValidationError("改写正文时必须同时更新独立brief");
  }
  validateMemoryText(body, brief);
  let groupId = old?.group_id;
  if (!groupId) {
    groupId = memoryId();
    await c.query("INSERT INTO agent_memory_group(id,scope_id) VALUES($1,$2)", [
      groupId,
      scopeId,
    ]);
  }
  if (old)
    await c.query(
      `UPDATE agent_memory_entry SET body=$3,brief=$4,group_id=$5,deleted_at=NULL,
    user_edited=$6,source='active',revision=revision+1,updated_at=clock_timestamp(),embedding=NULL,embedding_revision=NULL
    WHERE scope_id=$1 AND id=$2`,
      [scopeId, id, body, brief, groupId, input.actor === "user"],
    );
  else
    await c.query(
      "INSERT INTO agent_memory_entry(id,scope_id,group_id,brief,body,source,user_edited) VALUES($1,$2,$3,$4,$5,'active',$6)",
      [id, scopeId, groupId, brief, body, input.actor === "user"],
    );
  await refreshGroup(c, scopeId, groupId);
  await c.query(
    "UPDATE agent_memory_group SET in_cache=true,last_touched_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
    [scopeId, groupId],
  );
  return id;
}
export async function mutateMemoryEntry(
  userId: string,
  productionId: string | null,
  input: MemoryMutation,
): Promise<string> {
  return memoryTransaction(userId, productionId, async (c, s) => {
    if (input.actor === "agent")
      await checkMemoryOrigin(c, userId, productionId, input.runId);
    const id = await mutateEntryInTx(c, s.id, input);
    await c.query(
      "UPDATE agent_memory_scope SET revision=revision+1,history_cutoff=CASE WHEN $2 THEN clock_timestamp() ELSE history_cutoff END WHERE id=$1",
      [s.id, input.actor === "user" && input.action !== "create"],
    );
    if (input.actor === "user" && input.action !== "create")
      await c.query(
        "DELETE FROM agent_memory_chunk WHERE scope_type='user' AND scope_id=$1 AND source='episodic' AND ($2::text IS NULL OR production_id=$2)",
        [userId, productionId],
      );
    return id;
  });
}

// 历史检索沿用独立权限/截断边界，不成为自动注入的有效记忆。
export const VISIBLE_HISTORY = `c.scope_type='user' AND c.scope_id=$1 AND c.source='episodic' AND c.scope_known
  AND ($2::text IS NULL OR c.production_id=$2)
  AND (c.production_id IS NULL OR EXISTS(SELECT 1 FROM production p WHERE p.id=c.production_id
    AND (p.owner_id=$1::uuid OR EXISTS(SELECT 1 FROM production_member m WHERE m.production_id=p.id AND m.user_id=$1::uuid AND m.status='active'))))
  AND NOT EXISTS(SELECT 1 FROM agent_memory_scope s WHERE s.user_id=$1::uuid
    AND (s.scope_key=COALESCE(c.production_id,'') OR ($2::text IS NULL AND s.scope_key=''))
    AND s.history_cutoff IS NOT NULL AND c.observed_at<=s.history_cutoff)`;

export async function readMemoryAuditEntries(
  userId: string,
  ids: string[],
): Promise<
  Array<{ id: string; body: string; source: string; user_edited: boolean }>
> {
  return (
    await getPool().query<{
      id: string;
      body: string;
      source: string;
      user_edited: boolean;
    }>(
      "SELECT e.id,e.body,e.source,e.user_edited FROM agent_memory_entry e JOIN agent_memory_scope s ON s.id=e.scope_id WHERE s.user_id=$1 AND e.id=ANY($2::text[]) AND e.deleted_at IS NULL",
      [userId, ids],
    )
  ).rows;
}
export async function listMemoryEntryIds(userId: string): Promise<string[]> {
  return (
    await getPool().query<{ id: string }>(
      "SELECT e.id FROM agent_memory_entry e JOIN agent_memory_scope s ON s.id=e.scope_id WHERE s.user_id=$1 AND e.deleted_at IS NULL",
      [userId],
    )
  ).rows.map((e) => e.id);
}
