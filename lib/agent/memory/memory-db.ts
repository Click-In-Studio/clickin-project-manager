import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/pg";
import { MEMORY_ENTRY_MAX, MEMORY_SCOPE_MAX, type MemoryEntry, type MemoryScopeView } from "./memory-types";

const newId = () => `mem_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
export class MemoryAccessError extends Error {}
export class MemoryConflictError extends Error {}
export class MemoryValidationError extends Error {}

export async function requireMemoryAccess(userId: string, productionId: string | null, client?: PoolClient): Promise<void> {
  if (!productionId) return;
  // 自己的项目记忆只检查 owner/active 成员资格，不发行或借用业务 grant。
  // 持用户锁时复用事务连接，避免等锁请求耗尽连接池后再申请第二条连接。
  const rows = (await (client ?? getPool()).query(
    `SELECT p.id FROM production p WHERE p.id=$2 AND (p.owner_id=$1 OR EXISTS
      (SELECT 1 FROM production_member m WHERE m.production_id=p.id AND m.user_id=$1 AND m.status='active'))`,
    [userId, productionId])).rows;
  if (!rows.length) throw new MemoryAccessError("当前没有这个项目的访问资格");
}

// 所有条目写入、历史落库与 dream 提交共用用户锁，截断和晚完成归档有确定顺序。
export async function lockMemoryUser(client: PoolClient, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`agent-memory:${userId}`]);
}

type ScopeRow = { id: string; revision: string; consumed_seq: string; history_cutoff: Date | null; dream_project_ids: string[] };
type EntryRow = { id: string; body: string; source: "dream" | "active"; user_edited: boolean; revision: string; updated_at: Date; input_count: number };
function entry(row: EntryRow): MemoryEntry {
  return { id: row.id, body: row.body, source: row.source, userEdited: row.user_edited,
    revision: Number(row.revision), updatedAt: row.updated_at.toISOString(), inputCount: row.input_count };
}
async function ensureScope(client: PoolClient, userId: string, productionId: string | null): Promise<ScopeRow> {
  await client.query("INSERT INTO agent_memory_scope(id,user_id,scope_key,production_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,scope_key) DO UPDATE SET production_id=EXCLUDED.production_id",
    [newId(), userId, productionId ?? "", productionId]);
  let scope = (await client.query<ScopeRow>("SELECT * FROM agent_memory_scope WHERE user_id=$1 AND scope_key=$2 FOR UPDATE", [userId, productionId ?? ""])).rows[0];
  if (!productionId && scope.dream_project_ids.length) {
    const revoked = (await client.query(
      `SELECT pid FROM unnest($2::text[]) pid WHERE NOT EXISTS(SELECT 1 FROM production p WHERE p.id=pid
        AND (p.owner_id=$1 OR EXISTS(SELECT 1 FROM production_member m WHERE m.production_id=p.id AND m.user_id=$1 AND m.status='active')))`,
      [userId, scope.dream_project_ids])).rows;
    if (revoked.length) {
      // 批次依赖只证明整理曾用过哪些项目，不给单条事实伪造来源。
      // 失去资格时整组未编辑的通用 dream 退出，避免建立逐条派生图。
      await client.query("DELETE FROM agent_memory_entry WHERE scope_id=$1 AND source='dream' AND NOT user_edited", [scope.id]);
      scope = (await client.query<ScopeRow>("UPDATE agent_memory_scope SET revision=revision+1,dream_project_ids='{}' WHERE id=$1 RETURNING *", [scope.id])).rows[0];
    }
  }
  return scope;
}
async function readEntries(client: PoolClient, scopeId: string): Promise<MemoryEntry[]> {
  return (await client.query<EntryRow>("SELECT * FROM agent_memory_entry WHERE scope_id=$1 ORDER BY updated_at,id", [scopeId])).rows.map(entry);
}
export async function readMemoryScope(userId: string, productionId: string | null): Promise<MemoryScopeView> {
  await requireMemoryAccess(userId, productionId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockMemoryUser(client, userId);
    await requireMemoryAccess(userId, productionId, client);
    const scope = await ensureScope(client, userId, productionId);
    const entries = await readEntries(client, scope.id);
    await client.query("COMMIT");
    return { productionId, revision: Number(scope.revision), historyCutoff: scope.history_cutoff?.toISOString() ?? null, entries };
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
}

// 只有用户自己管理的记忆；项目资格是内容门，不发行项目 grant。
export async function listMemoryProjects(userId: string): Promise<Array<{ id: string; name: string }>> {
  return (await getPool().query<{ id: string; name: string }>(
    `SELECT p.id,p.name FROM production p WHERE p.owner_id=$1 OR EXISTS
      (SELECT 1 FROM production_member m WHERE m.production_id=p.id AND m.user_id=$1 AND m.status='active') ORDER BY p.name,p.id`, [userId])).rows;
}

function validateBody(body: string): string {
  const clean = body.trim();
  if (!clean || clean.length > MEMORY_ENTRY_MAX) throw new MemoryValidationError(`记忆正文需要 1–${MEMORY_ENTRY_MAX} 个字符`);
  return clean;
}

export async function mutateMemoryEntry(userId: string, productionId: string | null, input: {
  action: "create" | "update" | "delete"; id?: string; body?: string; revision?: number;
  actor: "user" | "agent"; runId?: string;
}): Promise<string> {
  await requireMemoryAccess(userId, productionId);
  const body = input.action === "delete" ? null : validateBody(input.body ?? "");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN"); await lockMemoryUser(client, userId);
    // 在取锁之后再次检查，等待期间撤销访问不能继续写入。
    await requireMemoryAccess(userId, productionId, client);
    const scope = await ensureScope(client, userId, productionId);
    if (input.actor === "agent") {
      const origin = input.runId ? (await client.query<{ production_id: string | null }>(
        "SELECT a.production_id FROM agent_run r JOIN agent_session a ON a.id=r.session_id WHERE r.id=$1 AND a.user_id=$2", [input.runId, userId])).rows[0] : null;
      if (input.runId && !origin) throw new MemoryAccessError("记忆写入 run 不属于当前用户");
      if (origin?.production_id) await requireMemoryAccess(userId, origin.production_id, client);
      // 时间比较留在 PostgreSQL 中，避免 JS Date 毫秒精度吃掉截断边界。
      const { rows } = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM agent_memory_scope s WHERE s.user_id=$1
          AND s.scope_key IN ('',$2,$4) AND s.history_cutoff IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM agent_run r JOIN agent_session a ON a.id=r.session_id
            WHERE r.id=$3 AND a.user_id=$1 AND r.started_at>s.history_cutoff AND a.created_at>s.history_cutoff)) AS blocked`,
        [userId, productionId ?? "", input.runId ?? null, origin?.production_id ?? ""]);
      if (rows[0].blocked) throw new MemoryConflictError("旧会话资料已退出记忆来源，请开始新的对话后记录");
    }
    const entries = await readEntries(client, scope.id);
    const old = input.action === "create" ? null : entries.find(e => e.id === input.id);
    if (input.action !== "create" && !old) throw new MemoryAccessError("记忆不存在或不属于这个范围");
    if (old && old.revision !== input.revision) throw new MemoryConflictError("记忆已变化，请重新加载后再修改");
    if (input.actor === "agent" && (input.action === "delete" || old?.userEdited)) {
      throw new MemoryAccessError("删除和用户已编辑的记忆只能由用户管理");
    }
    if (body && entries.some(e => e.id !== old?.id && e.body === body)) throw new MemoryConflictError("已有相同记忆，请修改已有条目");
    if (body && entries.filter(e => e.id !== old?.id).reduce((n, e) => n + e.body.length, body.length) > MEMORY_SCOPE_MAX) {
      throw new MemoryValidationError("这个范围的记忆已满，请整理已有条目");
    }
    const id = old?.id ?? newId();
    if (input.action === "delete") await client.query("DELETE FROM agent_memory_entry WHERE id=$1", [id]);
    else if (old) await client.query(
      `UPDATE agent_memory_entry SET body=$2,source=CASE WHEN $3 THEN source ELSE 'active' END,
       user_edited=$3,revision=revision+1,updated_at=now(),input_count=0 WHERE id=$1`, [id, body, input.actor === "user"]);
    else await client.query("INSERT INTO agent_memory_entry(id,scope_id,source,body,user_edited) VALUES($1,$2,'active',$3,$4)", [id, scope.id, body, input.actor === "user"]);
    // 用户更正/删除：旧材料不能重建被取代的说法。
    const cut = input.actor === "user" && input.action !== "create";
    await client.query(
      `UPDATE agent_memory_scope SET revision=revision+1,
       history_cutoff=CASE WHEN $2 THEN clock_timestamp() ELSE history_cutoff END,
       consumed_seq=CASE WHEN $2 THEN GREATEST(consumed_seq,COALESCE((SELECT max(history_seq) FROM agent_memory_chunk WHERE scope_id=$3 AND source='episodic'),0)) ELSE consumed_seq END WHERE id=$1`,
      [scope.id, cut, userId]);
    if (cut && productionId) {
      const general = (await client.query<{ id: string }>(
        "SELECT id FROM agent_memory_scope WHERE user_id=$1 AND scope_key='' AND $2=ANY(dream_project_ids) FOR UPDATE", [userId, productionId])).rows[0];
      if (general) {
        await client.query("DELETE FROM agent_memory_entry WHERE scope_id=$1 AND source='dream' AND NOT user_edited", [general.id]);
        await client.query("UPDATE agent_memory_scope SET revision=revision+1,dream_project_ids='{}' WHERE id=$1", [general.id]);
      }
    }
    // 历史不是另一份事实源；按作用域整体清理旧索引，归档文件仍由其自身保留策略管理。
    if (cut) await client.query("DELETE FROM agent_memory_chunk WHERE scope_type='user' AND scope_id=$1 AND source='episodic' AND ($2::text IS NULL OR production_id=$2)", [userId, productionId]);
    await client.query("COMMIT"); return id;
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
}

// 由服务端资格与作用域边界筛选。模型不能提供作者、项目归属或历史来源资格。
export const VISIBLE_HISTORY = `c.scope_type='user' AND c.scope_id=$1 AND c.source='episodic' AND c.scope_known
  AND ($2::text IS NULL OR c.production_id=$2)
  AND (c.production_id IS NULL OR EXISTS(SELECT 1 FROM production p WHERE p.id=c.production_id
    AND (p.owner_id=$1::uuid OR EXISTS(SELECT 1 FROM production_member m WHERE m.production_id=p.id AND m.user_id=$1::uuid AND m.status='active'))))
  AND NOT EXISTS(SELECT 1 FROM agent_memory_scope s WHERE s.user_id=$1::uuid
    AND (s.scope_key=COALESCE(c.production_id,'') OR ($2::text IS NULL AND s.scope_key=''))
    AND s.history_cutoff IS NOT NULL AND c.observed_at<=s.history_cutoff)`;

export type DreamSnapshot = {
  scopeId: string; userId: string; productionId: string | null; revision: number;
  nextSeq: string; sourceProjects: string[]; inputProjects: string[]; entries: MemoryEntry[]; inputs: Array<{ id: string; text: string }>;
};
export async function readDreamSnapshot(userId: string, productionId: string | null, maxChars: number): Promise<DreamSnapshot> {
  await requireMemoryAccess(userId, productionId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN"); await lockMemoryUser(client, userId);
    await requireMemoryAccess(userId, productionId, client);
    const scope = await ensureScope(client, userId, productionId);
    const rows = (await client.query<{ id: string; text: string; history_seq: string; production_id: string | null }>(
      `SELECT c.id,c.text,c.history_seq,c.production_id FROM agent_memory_chunk c WHERE ${VISIBLE_HISTORY} AND c.history_seq>$3 ORDER BY c.history_seq LIMIT 100`,
      [userId, productionId, scope.consumed_seq])).rows;
    let count = 0;
    const inputProjects = new Set<string>();
    const inputs: DreamSnapshot["inputs"] = [];
    let nextSeq = scope.consumed_seq;
    for (const row of rows) {
      if (inputs.length && count + row.text.length > maxChars) break;
      if (row.production_id) inputProjects.add(row.production_id);
      inputs.push({ id: row.id, text: row.text }); count += row.text.length; nextSeq = row.history_seq;
    }
    const entries = await readEntries(client, scope.id);
    await client.query("COMMIT");
    return { scopeId: scope.id, userId, productionId, revision: Number(scope.revision), nextSeq, sourceProjects: scope.dream_project_ids, inputProjects: [...inputProjects], entries, inputs };
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
}

export async function commitDream(snapshot: DreamSnapshot, bodies: string[] | null): Promise<boolean> {
  const clean = bodies?.map(validateBody);
  if (clean && new Set(clean).size !== clean.length) throw new Error("dream 输出重复条目");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN"); await lockMemoryUser(client, snapshot.userId);
    await requireMemoryAccess(snapshot.userId, snapshot.productionId, client);
    const scope = await ensureScope(client, snapshot.userId, snapshot.productionId);
    if (Number(scope.revision) !== snapshot.revision) { await client.query("ROLLBACK"); return false; }
    const eligible = (await client.query(
      `SELECT c.id FROM agent_memory_chunk c WHERE ${VISIBLE_HISTORY} AND c.id=ANY($3::uuid[])`,
      [snapshot.userId, snapshot.productionId, snapshot.inputs.map(i => i.id)])).rows;
    if (eligible.length !== snapshot.inputs.length) { await client.query("ROLLBACK"); return false; }
    const retained = snapshot.entries.filter(e => e.source === "active" || e.userEdited);
    const next = clean?.filter(body => !retained.some(e => e.body === body));
    if (next && [...next, ...retained.map(e => e.body)].reduce((n, body) => n + body.length, 0) > MEMORY_SCOPE_MAX) throw new Error("dream 输出超过记忆容量");
    if (next) {
      await client.query("DELETE FROM agent_memory_entry WHERE scope_id=$1 AND source='dream' AND NOT user_edited", [scope.id]);
      for (const body of next) {
        const old = snapshot.entries.find(e => e.source === "dream" && !e.userEdited && e.body === body);
        await client.query("INSERT INTO agent_memory_entry(id,scope_id,source,body,input_count,revision) VALUES($1,$2,'dream',$3,$4,$5)", [old?.id ?? newId(), scope.id, body, snapshot.inputs.length, old ? old.revision + 1 : 0]);
      }
    }
    const dependencies = next === undefined ? scope.dream_project_ids : next.length && !snapshot.productionId
      ? [...new Set([...snapshot.inputProjects, ...(snapshot.entries.some(e => e.source === "dream" && !e.userEdited) ? snapshot.sourceProjects : [])])] : [];
    await client.query("UPDATE agent_memory_scope SET consumed_seq=$2,revision=revision+1,dream_project_ids=$3 WHERE id=$1", [scope.id, snapshot.nextSeq, dependencies]);
    await client.query("COMMIT"); return true;
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
}

export async function listDreamScopes(): Promise<Array<{ userId: string; productionId: string | null }>> {
  const rows = (await getPool().query<{ user_id: string; production_id: string | null }>(
    `SELECT DISTINCT scope_id AS user_id,production_id FROM agent_memory_chunk WHERE scope_type='user' AND source='episodic' AND scope_known
     UNION SELECT DISTINCT scope_id,NULL::text FROM agent_memory_chunk WHERE scope_type='user' AND source='episodic' AND scope_known`)).rows;
  return rows.map(r => ({ userId: r.user_id, productionId: r.production_id }));
}

// 写审计只读取当前用户的目标条目，正文由审计层折算为字数，不保存事实来源声明。
export async function readMemoryAuditEntries(userId: string, ids: string[]): Promise<Array<{ id: string; body: string; source: string; user_edited: boolean }>> {
  return (await getPool().query<{ id: string; body: string; source: string; user_edited: boolean }>(
    "SELECT e.id,e.body,e.source,e.user_edited FROM agent_memory_entry e JOIN agent_memory_scope s ON s.id=e.scope_id WHERE s.user_id=$1 AND e.id=ANY($2::text[])", [userId, ids])).rows;
}
export async function listMemoryEntryIds(userId: string): Promise<string[]> {
  return (await getPool().query<{ id: string }>(
    "SELECT e.id FROM agent_memory_entry e JOIN agent_memory_scope s ON s.id=e.scope_id WHERE s.user_id=$1", [userId])).rows.map(e => e.id);
}
