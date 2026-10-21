import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/pg";
export const memoryId = () =>
  `mem_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
export class MemoryAccessError extends Error {}
export class MemoryConflictError extends Error {}
export class MemoryValidationError extends Error {}
export async function requireMemoryAccess(
  userId: string,
  productionId: string | null,
  client?: PoolClient,
): Promise<void> {
  if (!productionId) return;
  // 自己的项目记忆只检查 owner/active 成员资格，不发行或借用业务 grant。
  // 持用户锁时复用事务连接，避免等锁请求耗尽连接池后再申请第二条连接。
  const rows = (
    await (client ?? getPool()).query(
      `SELECT p.id FROM production p WHERE p.id=$2 AND (p.owner_id=$1 OR EXISTS
      (SELECT 1 FROM production_member m WHERE m.production_id=p.id AND m.user_id=$1 AND m.status='active'))`,
      [userId, productionId],
    )
  ).rows;
  if (!rows.length) throw new MemoryAccessError("当前没有这个项目的访问资格");
}

// 所有条目写入、历史落库与 dream 提交共用用户锁，截断和晚完成归档有确定顺序。
export async function lockMemoryUser(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `agent-memory:${userId}`,
  ]);
}

export type MemoryScopeRow = {
  id: string;
  revision: string;
  history_cutoff: Date | null;
};
export async function ensureMemoryScope(
  client: PoolClient,
  userId: string,
  productionId: string | null,
): Promise<MemoryScopeRow> {
  await client.query(
    "INSERT INTO agent_memory_scope(id,user_id,scope_key,production_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,scope_key) DO NOTHING",
    [memoryId(), userId, productionId ?? "", productionId],
  );
  return (
    await client.query<MemoryScopeRow>(
      "SELECT * FROM agent_memory_scope WHERE user_id=$1 AND scope_key=$2 FOR UPDATE",
      [userId, productionId ?? ""],
    )
  ).rows[0];
}

export async function memoryTransaction<T>(
  userId: string,
  productionId: string | null,
  work: (client: PoolClient, scope: MemoryScopeRow) => Promise<T>,
): Promise<T> {
  await requireMemoryAccess(userId, productionId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockMemoryUser(client, userId);
    await requireMemoryAccess(userId, productionId, client);
    const scope = await ensureMemoryScope(client, userId, productionId);
    const result = await work(client, scope);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkMemoryOrigin(
  client: PoolClient,
  userId: string,
  productionId: string | null,
  runId?: string,
): Promise<void> {
  const origin = runId
    ? (
        await client.query<{ production_id: string | null }>(
          "SELECT a.production_id FROM agent_run r JOIN agent_session a ON a.id=r.session_id WHERE r.id=$1 AND a.user_id=$2",
          [runId, userId],
        )
      ).rows[0]
    : null;
  if (runId && !origin)
    throw new MemoryAccessError("记忆写入 run 不属于当前用户");
  if (origin?.production_id)
    await requireMemoryAccess(userId, origin.production_id, client);
  const { rows } = await client.query<{ blocked: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM agent_memory_scope s WHERE s.user_id=$1 AND s.scope_key IN ('',$2,$4)
      AND s.history_cutoff IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent_run r JOIN agent_session a ON a.id=r.session_id
      WHERE r.id=$3 AND a.user_id=$1 AND r.started_at>s.history_cutoff AND a.created_at>s.history_cutoff)) AS blocked`,
    [userId, productionId ?? "", runId ?? null, origin?.production_id ?? ""],
  );
  if (rows[0].blocked)
    throw new MemoryConflictError(
      "旧会话资料已退出记忆来源，请开始新的对话后记录",
    );
}
