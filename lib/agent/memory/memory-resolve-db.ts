import {
  memoryTransaction,
  checkMemoryOrigin,
  MemoryAccessError,
  MemoryConflictError,
  MemoryValidationError,
} from "./memory-access-db";
import { mutateEntryInTx, type MemoryMutation } from "./memory-db";
import { splitGroup } from "./memory-group-db";

export type MemoryResolution = {
  groupId: string;
  revision: number;
  relationIds: string[];
  changes: Array<{
    id: string;
    revision: number;
    body?: string;
    brief?: string;
    remove?: boolean;
  }>;
  reason: string;
};
/** 主模型显式裁决；一次事务提交正文维护与关系解除，旧修订全部拒绝。 */
export async function resolveMemoryGroup(
  userId: string,
  productionId: string | null,
  input: MemoryResolution,
  runId?: string,
): Promise<void> {
  if (
    (!input.changes.length && !input.relationIds.length) ||
    !input.reason?.trim() ||
    input.reason.length > 1000 ||
    input.changes.length > 50 ||
    input.relationIds.length > 100
  )
    throw new MemoryValidationError("无效核对结果");
  if (new Set(input.changes.map((e) => e.id)).size !== input.changes.length)
    throw new MemoryValidationError("同一条目不能重复修改");
  await memoryTransaction(userId, productionId, async (c, s) => {
    await checkMemoryOrigin(c, userId, productionId, runId);
    const group = (
      await c.query<{ revision: string }>(
        "SELECT revision FROM agent_memory_group WHERE scope_id=$1 AND id=$2",
        [s.id, input.groupId],
      )
    ).rows[0];
    if (!group) throw new MemoryAccessError("记忆组不存在");
    if (Number(group.revision) !== input.revision)
      throw new MemoryConflictError("记忆组已变化，请重新核对");
    await c.query(
      "UPDATE agent_memory_group SET in_cache=true,last_touched_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
      [s.id, input.groupId],
    );
    const ids = input.changes.map((e) => e.id);
    if (
      ids.length &&
      (
        await c.query(
          "SELECT id FROM agent_memory_entry WHERE scope_id=$1 AND group_id=$2 AND id=ANY($3::text[]) AND deleted_at IS NULL",
          [s.id, input.groupId, ids],
        )
      ).rowCount !== ids.length
    )
      throw new MemoryAccessError("修改包含组外条目");
    const relationIds = [...new Set(input.relationIds)];
    const edges = await c.query(
      "SELECT r.id FROM agent_memory_relation r JOIN agent_memory_entry e ON e.id=r.left_entry_id AND e.scope_id=r.scope_id WHERE r.scope_id=$1 AND e.group_id=$2 AND r.resolved_at IS NULL AND r.id=ANY($3::text[])",
      [s.id, input.groupId, relationIds],
    );
    if (edges.rowCount !== relationIds.length)
      throw new MemoryAccessError("核对包含组外关系");
    // 先解除指定关系，再维护条目；删除条目还会删除其全部悬空关联。
    await c.query(
      "UPDATE agent_memory_relation SET resolved_at=clock_timestamp() WHERE scope_id=$1 AND id=ANY($2::text[])",
      [s.id, relationIds],
    );
    for (const change of input.changes) {
      const mutation: MemoryMutation = {
        ...change,
        action: change.remove ? "delete" : "update",
        actor: "agent",
        runId,
      };
      await mutateEntryInTx(c, s.id, mutation);
    }
    // 删除某节点已可能局部拆组；重新收集受影响成员当前所在组，避免漏拆。
    const groups = (
      await c.query<{ group_id: string }>(
        "SELECT DISTINCT group_id FROM agent_memory_entry WHERE scope_id=$1 AND deleted_at IS NULL AND (group_id=$2 OR id=ANY($3::text[]))",
        [s.id, input.groupId, ids],
      )
    ).rows;
    for (const g of groups) await splitGroup(c, s.id, g.group_id);
    await c.query(
      "UPDATE agent_memory_scope SET revision=revision+1 WHERE id=$1",
      [s.id],
    );
  });
}
