/**
 * 用户组（event_group）的读写与解析。
 *
 * 组 = 若干「部门」+ 若干「人」的集合，自带一个 POC（部门或人，二选一）。
 * 两型由 `eventId` 是否为 null 区分（A 型 = 某 event 专属，B 型 = 项目级常驻编制），
 * 门在 lib/event-group-perm.ts，本文件不判权限。
 *
 * ## 两条解析口径（这个文件存在的主要理由）
 *
 * **成员解析是活引用。** 组里放一个「灯光部」，语义是「灯光部整体在这个组里」——
 * 灯光部后来加了人，那个人当然也在组里。这是用户明确定的：「结果有人加入灯光部
 * 那当然应该自动进这个组」。所以 {@link resolveGroupUserIds} 每次都实时展开，
 * 不缓存、不落行。
 *
 * **POC 解析同样是活引用。** dept 型 POC 的语义是「该部门的现任 POC 即本组 POC」，
 * 部门换 POC 自动跟随。这与 lib/task-poc.ts 的 Type B 口径一致。
 *
 * 冻结（PR④）会把某个 event 对某个组的解析结果物化成快照，之后该 event 读快照
 * 不再走这里——但那是冻结层的事，本文件只负责「现在是什么」。
 */

import { getPool } from "./pg";
import type { PoolClient } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

/** 组的成员项：一个部门，或一个人。 */
export type EventGroupMember =
  | { kind: "dept"; id: string }
  | { kind: "user"; id: string };

/** 组的 POC：一个部门（取其现任 POC）、一个人，或未设。 */
export type EventGroupPoc =
  | { kind: "dept"; id: string }
  | { kind: "user"; id: string }
  | null;

export type EventGroup = {
  id: string;
  productionId: string;
  /** null = B 型（项目级常驻编制）；非 null = A 型（该 event 专属） */
  eventId: string | null;
  name: string;
  location: string;
  color: string | null;
  orderIndex: number;
  poc: EventGroupPoc;
  members: EventGroupMember[];
  createdBy: string;
  createdAt: string;
};

/** A 型 / B 型的判定只看 eventId，不设独立的 type 列——列会和 eventId 漂。 */
export function groupScope(group: Pick<EventGroup, "eventId">): "event" | "production" {
  return group.eventId === null ? "production" : "event";
}

type GroupRow = {
  id: string;
  production_id: string;
  event_id: string | null;
  name: string;
  location: string;
  color: string | null;
  order_index: number;
  poc_dept_id: string | null;
  poc_user_id: string | null;
  created_by: string;
  created_at: Date;
};

function rowToPoc(r: Pick<GroupRow, "poc_dept_id" | "poc_user_id">): EventGroupPoc {
  if (r.poc_dept_id) return { kind: "dept", id: r.poc_dept_id };
  if (r.poc_user_id) return { kind: "user", id: r.poc_user_id };
  return null;
}

function rowToGroup(r: GroupRow, members: EventGroupMember[]): EventGroup {
  return {
    id: r.id,
    productionId: r.production_id,
    eventId: r.event_id,
    name: r.name,
    location: r.location,
    color: r.color,
    orderIndex: r.order_index,
    poc: rowToPoc(r),
    members,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

async function membersByGroup(groupIds: string[]): Promise<Map<string, EventGroupMember[]>> {
  const map = new Map<string, EventGroupMember[]>();
  if (!groupIds.length) return map;
  const res = await getPool().query<{ group_id: string; dept_id: string | null; user_id: string | null }>(
    `SELECT group_id, dept_id, user_id FROM event_group_member
     WHERE group_id = ANY($1::uuid[])
     ORDER BY added_at`,
    [groupIds],
  );
  for (const row of res.rows) {
    if (!map.has(row.group_id)) map.set(row.group_id, []);
    map.get(row.group_id)!.push(
      row.dept_id ? { kind: "dept", id: row.dept_id } : { kind: "user", id: row.user_id! },
    );
  }
  return map;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * 列出组。
 *
 * `eventId` 给定时返回「该 event 的 A 型组 + 全部 B 型组」——这正是排某个 event 的
 * rundown 时可选的全集。不给则只返回 B 型组。
 */
export async function listEventGroups(
  productionId: string,
  eventId?: string | null,
): Promise<EventGroup[]> {
  const res = await getPool().query<GroupRow>(
    `SELECT * FROM event_group
     WHERE production_id = $1
       AND (event_id IS NULL OR ($2::text IS NOT NULL AND event_id = $2))
     ORDER BY (event_id IS NULL) DESC, order_index, name`,
    [productionId, eventId ?? null],
  );
  const members = await membersByGroup(res.rows.map(r => r.id));
  return res.rows.map(r => rowToGroup(r, members.get(r.id) ?? []));
}

export async function getEventGroup(groupId: string, productionId: string): Promise<EventGroup | null> {
  const res = await getPool().query<GroupRow>(
    "SELECT * FROM event_group WHERE id = $1 AND production_id = $2",
    [groupId, productionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const members = await membersByGroup([row.id]);
  return rowToGroup(row, members.get(row.id) ?? []);
}

// ─── 解析（活引用） ───────────────────────────────────────────────────────────

/**
 * 组当前包含哪些人：直接成员 ∪ 成员部门的当前全体成员。
 *
 * 部门那一支是活引用——部门加人自动进组，这是用户定的语义。所以本函数不缓存，
 * 每次实时展开。
 */
export async function resolveGroupUserIds(groupId: string): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT egm.user_id
       FROM event_group_member egm
      WHERE egm.group_id = $1 AND egm.user_id IS NOT NULL
      UNION
     SELECT pdm.user_id
       FROM event_group_member egm
       JOIN production_dept_member pdm ON pdm.dept_id = egm.dept_id
      WHERE egm.group_id = $1 AND egm.dept_id IS NOT NULL`,
    [groupId],
  );
  return res.rows.map(r => r.user_id);
}

/**
 * 组的当前 POC 是哪些人。
 *
 * - user 型 → 就是那个人
 * - dept 型 → 该部门的**现任** POC（可能多人，也可能一个都没有）
 * - 未设   → 空
 *
 * dept 型返回多人不是缺陷：责任单点指的是「责任主体唯一」（这个组 / 这个部门），
 * 不是「自然人唯一」。部门本来就允许多 POC，见 production_dept_member.is_poc。
 */
export async function resolveGroupPocUserIds(groupId: string): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT eg.poc_user_id AS user_id
       FROM event_group eg
      WHERE eg.id = $1 AND eg.poc_user_id IS NOT NULL
      UNION
     SELECT pdm.user_id
       FROM event_group eg
       JOIN production_dept_member pdm
         ON pdm.dept_id = eg.poc_dept_id AND pdm.is_poc = true
      WHERE eg.id = $1 AND eg.poc_dept_id IS NOT NULL`,
    [groupId],
  );
  return res.rows.map(r => r.user_id);
}

/** 他是不是这个组的现任 POC。 */
export async function isGroupPoc(groupId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_group eg
        WHERE eg.id = $1
          AND (eg.poc_user_id = $2
               OR EXISTS (SELECT 1 FROM production_dept_member pdm
                           WHERE pdm.dept_id = eg.poc_dept_id
                             AND pdm.user_id = $2 AND pdm.is_poc = true))
     ) AS exists`,
    [groupId, userId],
  );
  return res.rows[0].exists;
}

/**
 * 他在这个 event 的哪些组里（含通过成员部门带入的）。
 *
 * 「在用户组里面参加 = 原来的直接参加」——组成员的参与效果等同于直挂到流程项上，
 * 事件可见性判定用它（Type B，不落 grant 行，部门加人自动跟踪）。
 */
export async function userGroupIdsInEvent(eventId: string, userId: string): Promise<string[]> {
  // 组进入一个 event 有两条通道，都要认：
  //   1. 挂在该 event 的流程项上（rundown 的列）
  //   2. 作为该 event 下某条 task 的责任主体（task.group_id）
  // 少认第 2 条的话，「这件事交给进场对光小组」之后组员看不见这个 event——正是
  // 用户说的「不然他们怎么知道他们要干什么」。
  const res = await getPool().query<{ group_id: string }>(
    `WITH event_groups AS (
       SELECT sig.group_id
         FROM schedule_item_group sig
         JOIN event_schedule_item esi ON esi.id = sig.item_id
        WHERE esi.event_id = $1
       UNION
       SELECT t.group_id
         FROM task t
        WHERE t.event_id = $1 AND t.group_id IS NOT NULL
     )
     SELECT DISTINCT eg.group_id
       FROM event_groups eg
       JOIN event_group_member egm ON egm.group_id = eg.group_id
       LEFT JOIN production_dept_member pdm
              ON pdm.dept_id = egm.dept_id AND pdm.user_id = $2
      WHERE egm.user_id = $2 OR pdm.user_id IS NOT NULL`,
    [eventId, userId],
  );
  return res.rows.map(r => r.group_id);
}

/** 他是不是这个组的成员（含通过成员部门带入）。task 可见性判定用。 */
export async function isGroupMember(groupId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_group_member egm
        LEFT JOIN production_dept_member pdm
               ON pdm.dept_id = egm.dept_id AND pdm.user_id = $2
        WHERE egm.group_id = $1 AND (egm.user_id = $2 OR pdm.user_id IS NOT NULL)
     ) AS exists`,
    [groupId, userId],
  );
  return res.rows[0].exists;
}

// ─── Write ────────────────────────────────────────────────────────────────────

export class EventGroupError extends Error {
  constructor(readonly reason: "poc_not_member" | "member_out_of_production" | "in_use", message: string) {
    super(message);
  }
}

/**
 * 成员必须属于本 production——组是 production 内的编制，放进跨剧组的部门/人会让
 * 解析出的名单越界（同 task POC 判定加 production 作用域的理由）。
 */
async function assertMembersInProduction(
  client: PoolClient,
  productionId: string,
  members: EventGroupMember[],
): Promise<void> {
  const deptIds = members.filter(m => m.kind === "dept").map(m => m.id);
  const userIds = members.filter(m => m.kind === "user").map(m => m.id);
  if (deptIds.length) {
    const res = await client.query(
      "SELECT id FROM production_dept WHERE production_id = $1 AND id = ANY($2::uuid[])",
      [productionId, deptIds],
    );
    if (res.rowCount !== deptIds.length)
      throw new EventGroupError("member_out_of_production", "包含不属于本项目的部门");
  }
  if (userIds.length) {
    const res = await client.query(
      "SELECT user_id FROM production_member WHERE production_id = $1 AND user_id = ANY($2::uuid[])",
      [productionId, userIds],
    );
    if (res.rowCount !== userIds.length)
      throw new EventGroupError("member_out_of_production", "包含不是本项目成员的人");
  }
}

/** POC 必须是本组的直接成员——「以**其中的**一个部门/人为 POC」。 */
function assertPocIsMember(poc: EventGroupPoc, members: EventGroupMember[]): void {
  if (!poc) return;
  const ok = members.some(m => m.kind === poc.kind && m.id === poc.id);
  if (!ok) throw new EventGroupError("poc_not_member", "POC 必须是本组成员");
}

async function replaceMembers(
  client: PoolClient,
  groupId: string,
  members: EventGroupMember[],
): Promise<void> {
  await client.query("DELETE FROM event_group_member WHERE group_id = $1", [groupId]);
  for (const m of members) {
    await client.query(
      `INSERT INTO event_group_member (group_id, dept_id, user_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [groupId, m.kind === "dept" ? m.id : null, m.kind === "user" ? m.id : null],
    );
  }
}

export async function createEventGroup(params: {
  productionId: string;
  /** null = B 型项目级组 */
  eventId: string | null;
  name: string;
  location?: string;
  color?: string | null;
  orderIndex?: number;
  members: EventGroupMember[];
  poc: EventGroupPoc;
  createdBy: string;
}): Promise<EventGroup> {
  const members = dedupeMembers(params.members);
  assertPocIsMember(params.poc, members);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertMembersInProduction(client, params.productionId, members);
    const res = await client.query<{ id: string }>(
      `INSERT INTO event_group
         (production_id, event_id, name, location, color, order_index,
          poc_dept_id, poc_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        params.productionId, params.eventId, params.name.trim(),
        params.location ?? "", params.color ?? null, params.orderIndex ?? 0,
        params.poc?.kind === "dept" ? params.poc.id : null,
        params.poc?.kind === "user" ? params.poc.id : null,
        params.createdBy,
      ],
    );
    await replaceMembers(client, res.rows[0].id, members);
    await client.query("COMMIT");
    const created = await getEventGroup(res.rows[0].id, params.productionId);
    if (!created) throw new Error(`event_group not found after create: ${res.rows[0].id}`);
    return created;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function dedupeMembers(members: EventGroupMember[]): EventGroupMember[] {
  const seen = new Set<string>();
  return members.filter(m => {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 改组。members / poc 同事务处理——POC 必须是成员这条约束跨两张表，分两次调用
 * 会出现「先删成员后改 POC」的中间态，那一刻 POC 已经不是成员了。
 */
export async function updateEventGroup(
  groupId: string,
  productionId: string,
  fields: {
    name?: string;
    location?: string;
    color?: string | null;
    orderIndex?: number;
    members?: EventGroupMember[];
    poc?: EventGroupPoc;
  },
): Promise<EventGroup | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<GroupRow>(
      "SELECT * FROM event_group WHERE id = $1 AND production_id = $2 FOR UPDATE",
      [groupId, productionId],
    );
    if (!cur.rows[0]) { await client.query("ROLLBACK"); return null; }

    const curMembers = (await membersByGroup([groupId])).get(groupId) ?? [];
    const members = fields.members ? dedupeMembers(fields.members) : curMembers;
    const poc = fields.poc !== undefined ? fields.poc : rowToPoc(cur.rows[0]);
    assertPocIsMember(poc, members);
    if (fields.members) await assertMembersInProduction(client, productionId, members);

    const sets: string[] = [];
    const vals: unknown[] = [groupId];
    if (fields.name      !== undefined) sets.push(`name        = $${vals.push(fields.name.trim())}`);
    if (fields.location  !== undefined) sets.push(`location    = $${vals.push(fields.location)}`);
    if (fields.color     !== undefined) sets.push(`color       = $${vals.push(fields.color)}`);
    if (fields.orderIndex!== undefined) sets.push(`order_index = $${vals.push(fields.orderIndex)}`);
    if (fields.poc       !== undefined) {
      sets.push(`poc_dept_id = $${vals.push(poc?.kind === "dept" ? poc.id : null)}`);
      sets.push(`poc_user_id = $${vals.push(poc?.kind === "user" ? poc.id : null)}`);
    }
    if (sets.length) {
      await client.query(`UPDATE event_group SET ${sets.join(", ")} WHERE id = $1`, vals);
    }
    if (fields.members) await replaceMembers(client, groupId, members);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return getEventGroup(groupId, productionId);
}

/**
 * 删组。
 *
 * 解散守卫：还挂在流程项上的组不许删（同 dept 被 resource_dept_manage 引用时的
 * 处理）。PR④ 冻结落地后这里还要加一条——**已冻结的引用不构成阻拦**，因为快照
 * 自带组名与 POC 快照，删掉组行也解析得出；挡的只是活引用。
 */
export async function deleteEventGroup(groupId: string, productionId: string): Promise<void> {
  const inUse = await getPool().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM schedule_item_group WHERE group_id = $1",
    [groupId],
  );
  if (Number(inUse.rows[0].n) > 0)
    throw new EventGroupError("in_use", "该组仍挂在流程项上，先从流程项上移除再删除");
  await getPool().query("DELETE FROM event_group WHERE id = $1 AND production_id = $2", [groupId, productionId]);
}

// ─── 流程项 ↔ 组 ──────────────────────────────────────────────────────────────

export async function listScheduleItemGroupIds(eventId: string): Promise<Map<string, string[]>> {
  const res = await getPool().query<{ item_id: string; group_id: string }>(
    `SELECT sig.item_id, sig.group_id
       FROM schedule_item_group sig
       JOIN event_schedule_item esi ON esi.id = sig.item_id
      WHERE esi.event_id = $1`,
    [eventId],
  );
  const map = new Map<string, string[]>();
  for (const r of res.rows) {
    if (!map.has(r.item_id)) map.set(r.item_id, []);
    map.get(r.item_id)!.push(r.group_id);
  }
  return map;
}

/**
 * 全量覆盖某个流程项挂的组。
 *
 * 只接受「本 event 的 A 型组」与「本 production 的 B 型组」——A 型组被别的 event
 * 引用会让 event A 的 organizer 改组影响到 event B，那正是两型要分开的原因。
 */
export async function setScheduleItemGroups(
  itemId: string,
  eventId: string,
  productionId: string,
  groupIds: string[],
): Promise<void> {
  const unique = [...new Set(groupIds)];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (unique.length) {
      const ok = await client.query(
        `SELECT id FROM event_group
          WHERE id = ANY($1::uuid[]) AND production_id = $2
            AND (event_id IS NULL OR event_id = $3)`,
        [unique, productionId, eventId],
      );
      if (ok.rowCount !== unique.length)
        throw new EventGroupError("member_out_of_production", "包含不可用于本事件的用户组");
    }
    await client.query("DELETE FROM schedule_item_group WHERE item_id = $1", [itemId]);
    for (const groupId of unique) {
      await client.query(
        "INSERT INTO schedule_item_group (item_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [itemId, groupId],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
