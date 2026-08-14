import { getPool } from "./pg";
import { writeEventGrants, writeReportGrants, writeTechReqGrants } from "./resource-grant-db";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventDepartment = {
  id: string;
  productionId: string;
  name: string;
  /** 'dept' = 部门 (can be mentioned in report notes); 'group' = 用户组 (call selection only) */
  kind: "dept" | "group";
  displayOrder: number;
  memberUserIds: string[];
  pocUserIds: string[];
  chatId: string | null;
  createdAt: string;
};

export type ProductionEvent = {
  id: string;
  productionId: string;
  title: string;
  eventType: string;
  location: string;
  startTime: string | null;
  endTime: string | null;
  status: "draft" | "published" | "completed" | "cancelled";
  description: string;
  stageManagers: { userId: string; name: string }[];
  chatId: string | null;
  versionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type EventScheduleItem = {
  id: string;
  eventId: string;
  title: string;
  itemType: string;
  startTime: string | null;
  endTime: string | null;
  location: string;
  orderIndex: number;
  targetSceneId: string | null;
  targetBlockId: string | null;
  notes: string;
};

export type ScheduleItemParticipant = { userId: string; name: string };

export type EventScheduleItemWithParticipants = EventScheduleItem & {
  participants: ScheduleItemParticipant[];
  departmentIds: string[];
};

export type EventParticipant = {
  id: string;
  eventId: string;
  userId: string;
  name: string;
  departmentId: string | null;
  role: "participant" | "follower";
};

export type EventCallTime = {
  id: string;
  eventId: string;
  userId: string;
  name: string;
  departmentId: string | null;
  callAt: string;
  scheduleItemId: string | null;
  notes: string;
};

export type EventTechReqAssignee = { userId: string; name: string };

export type EventTechReq = {
  id: string;
  eventId: string;
  scheduleItemIds: string[];
  title: string;
  description: string;
  presetMinutes: number | null;
  departmentId: string | null;
  status: string;
  assignees: EventTechReqAssignee[];
  chatId: string | null;
  createdAt: string;
  createdVia: "explicit" | "dept_auto" | "poc";
};

export type Mention = { userId: string; name: string };

export type EventReport = {
  id: string;
  eventId: string;
  reportType: string;
  title: string;
  body: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  mentions: Mention[];
};

export type EventReportNote = {
  id: string;
  reportId: string;
  departmentId: string;
  content: string;
  authorUserId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  mentions: Mention[];
  createdVia: "dept" | "wildcard" | "moderator";
};

export type UnreadReportEntry = {
  reportId: string;
  reportTitle: string;
  /** null for draft reports awaiting publication */
  publishedAt: string | null;
  eventId: string;
  eventTitle: string;
  productionId: string;
  productionName: string;
};

// ─── Row types (internal) ─────────────────────────────────────────────────────

type DeptRow = {
  id: string; production_id: string; name: string;
  kind: string; display_order: number; chat_id: string | null; created_at: Date;
};

type EventRow = {
  id: string; production_id: string; title: string; event_type: string;
  location: string; start_time: Date | null; end_time: Date | null;
  status: string; description: string; chat_id: string | null;
  version_id: string | null;
  created_by: string; created_at: Date; updated_at: Date;
};

type ScheduleItemRow = {
  id: string; event_id: string; title: string; item_type: string;
  start_time: Date | null; end_time: Date | null; location: string;
  order_index: number; target_scene_id: string | null;
  target_block_id: string | null; notes: string;
};

type ParticipantRow = {
  id: string; event_id: string; user_id: string; name: string;
  department_id: string | null; role: string;
};

type CallTimeRow = {
  id: string; event_id: string; user_id: string; name: string;
  department_id: string | null; call_at: Date;
  schedule_item_id: string | null; notes: string;
};

type TechReqRow = {
  id: string; event_id: string;
  title: string; description: string; preset_minutes: number | null;
  department_id: string | null; status: string; chat_id: string | null; created_at: Date;
  created_via?: string | null;
};

type TechAssigneeRow = { req_id: string; user_id: string; name: string };

type ReportRow = {
  id: string; event_id: string; report_type: string; title: string;
  body: string; created_by: string; created_at: Date; updated_at: Date;
  published_at: Date | null; mentions: Mention[];
};

type ReportNoteRow = {
  id: string; report_id: string; department_id: string; content: string;
  author_user_id: string; author_name: string;
  created_at: Date; updated_at: Date; mentions: Mention[];
  created_via: "dept" | "wildcard" | "moderator";
};

// ─── Row converters ───────────────────────────────────────────────────────────

function rowToDept(r: DeptRow, memberUserIds: string[], pocUserIds: string[]): EventDepartment {
  return {
    id: r.id, productionId: r.production_id, name: r.name,
    kind: r.kind as EventDepartment["kind"], displayOrder: r.display_order,
    memberUserIds, pocUserIds, chatId: r.chat_id ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

function rowToEvent(r: EventRow, stageManagers: { userId: string; name: string }[] = []): ProductionEvent {
  return {
    id: r.id, productionId: r.production_id, title: r.title,
    eventType: r.event_type, location: r.location,
    startTime: r.start_time?.toISOString() ?? null,
    endTime: r.end_time?.toISOString() ?? null,
    status: r.status as ProductionEvent["status"],
    description: r.description,
    stageManagers,
    chatId: r.chat_id ?? null,
    versionId: r.version_id ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

function rowToScheduleItem(r: ScheduleItemRow): EventScheduleItem {
  return {
    id: r.id, eventId: r.event_id, title: r.title, itemType: r.item_type,
    startTime: r.start_time?.toISOString() ?? null,
    endTime: r.end_time?.toISOString() ?? null,
    location: r.location, orderIndex: r.order_index,
    targetSceneId: r.target_scene_id, targetBlockId: r.target_block_id,
    notes: r.notes,
  };
}

function rowToParticipant(r: ParticipantRow): EventParticipant {
  return {
    id: r.id, eventId: r.event_id, userId: r.user_id, name: r.name,
    departmentId: r.department_id, role: r.role as EventParticipant["role"],
  };
}

function rowToCallTime(r: CallTimeRow): EventCallTime {
  return {
    id: r.id, eventId: r.event_id, userId: r.user_id, name: r.name,
    departmentId: r.department_id, callAt: r.call_at.toISOString(),
    scheduleItemId: r.schedule_item_id, notes: r.notes,
  };
}

function rowToTechReq(r: TechReqRow, assignees: EventTechReqAssignee[], scheduleItemIds: string[]): EventTechReq {
  return {
    id: r.id, eventId: r.event_id, scheduleItemIds,
    title: r.title, description: r.description,
    presetMinutes: r.preset_minutes, departmentId: r.department_id,
    status: r.status, assignees, chatId: r.chat_id ?? null,
    createdVia: (r.created_via ?? "explicit") as "explicit" | "dept_auto" | "poc",
    createdAt: r.created_at.toISOString(),
  };
}

function rowToReport(r: ReportRow): EventReport {
  return {
    id: r.id, eventId: r.event_id, reportType: r.report_type,
    title: r.title, body: r.body, createdBy: r.created_by,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    publishedAt: r.published_at?.toISOString() ?? null,
    mentions: r.mentions ?? [],
  };
}

function rowToReportNote(r: ReportNoteRow): EventReportNote {
  return {
    id: r.id, reportId: r.report_id, departmentId: r.department_id,
    content: r.content, authorUserId: r.author_user_id, authorName: r.author_name,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    mentions: r.mentions ?? [], createdVia: r.created_via,
  };
}

// ─── Departments ──────────────────────────────────────────────────────────────
// 并表后（migrate-merge-event-department）：单一数据源 production_dept /
// production_dept_member。本文件仅保留事件业务侧的**读**函数（形状兼容旧
// EventDepartment）；全部写路径归 lib/dept-db.ts（含 POC notes 三行 diff）。

type MemberRow = { department_id: string; user_id: string; is_poc: boolean };

export async function listEventDepartments(productionId: string): Promise<EventDepartment[]> {
  const pool = getPool();
  const [deptRes, memberRes] = await Promise.all([
    pool.query<DeptRow>(
      `SELECT id, production_id, name, kind, display_order, chat_id, created_at
       FROM production_dept WHERE production_id = $1 ORDER BY display_order, name`,
      [productionId]
    ),
    pool.query<MemberRow>(
      `SELECT dept_id AS department_id, user_id, is_poc
       FROM production_dept_member WHERE production_id = $1`,
      [productionId]
    ),
  ]);
  const memberMap = new Map<string, MemberRow[]>();
  for (const r of memberRes.rows) {
    if (!memberMap.has(r.department_id)) memberMap.set(r.department_id, []);
    memberMap.get(r.department_id)!.push(r);
  }
  return deptRes.rows.map(r => {
    const rows = memberMap.get(r.id) ?? [];
    return rowToDept(
      r,
      rows.map(m => m.user_id),
      rows.filter(m => m.is_poc).map(m => m.user_id),
    );
  });
}

export async function getEventDepartment(id: string, productionId: string): Promise<EventDepartment | null> {
  const pool = getPool();
  const [deptRes, memberRes] = await Promise.all([
    pool.query<DeptRow>(
      `SELECT id, production_id, name, kind, display_order, chat_id, created_at
       FROM production_dept WHERE id = $1 AND production_id = $2`,
      [id, productionId]
    ),
    pool.query<{ user_id: string; is_poc: boolean }>(
      "SELECT user_id, is_poc FROM production_dept_member WHERE dept_id = $1",
      [id]
    ),
  ]);
  if (!deptRes.rows[0]) return null;
  return rowToDept(
    deptRes.rows[0],
    memberRes.rows.map(r => r.user_id),
    memberRes.rows.filter(r => r.is_poc).map(r => r.user_id),
  );
}

/** Replace the full participant list for an event in one transaction.
 *  Writes an assigned view grant for each new participant. */
export async function setEventParticipants(
  eventId: string,
  participants: { userId: string; name: string; departmentId: string | null; role: "participant" | "follower" }[],
  productionId: string,
  assignedBy: string,
): Promise<void> {
  const seen = new Set<string>();
  const unique = participants.filter(p => { if (seen.has(p.userId)) return false; seen.add(p.userId); return true; });
  let _s = 0;
  const pid = () => `ep${Date.now().toString(36)}${(++_s).toString(36)}`;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_participant WHERE event_id = $1", [eventId]);
    for (const p of unique) {
      await client.query(
        "INSERT INTO event_participant (id, event_id, user_id, name, department_id, role) VALUES ($1,$2,$3,$4,$5,$6)",
        [pid(), eventId, p.userId, p.name, p.departmentId, p.role],
      );
    }
    // 被指派自动授权：meta+details view（五层模型第②层——不用 '*' 通配，
    // 那会把 call_sheet/tasks/reports 层白送）。写入即独立事实：移除参与者
    // **不**自动撤行（撤销走 sweep/手动；模板只是模板）。
    if (unique.length > 0) {
      await client.query(
        `INSERT INTO production_member_grant
           (production_id, user_id, resource_type, resource_id, resource_sub,
            permission_level, grant_source, confirmed_by)
         SELECT $1, u, 'event', $3, s.sub, 'view', 'assigned', $4
         FROM unnest($2::uuid[]) AS u
         CROSS JOIN (VALUES ('meta'), ('details')) AS s(sub)
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
           WHERE is_revoked = false
         DO NOTHING`,
        [productionId, unique.map(p => p.userId), eventId, assignedBy],
      );
    }
    // 部门加入 event（批C C3）：参与部门的 POC 获得 draft report 可见
    // （event/<id>/reports@view）——发布前给本部门写 note 的前提，POC 本人无需在场。
    const deptIds = [...new Set(unique.map(p => p.departmentId).filter((d): d is string => d !== null))];
    if (deptIds.length > 0) {
      await client.query(
        `INSERT INTO production_member_grant
           (production_id, user_id, resource_type, resource_id, resource_sub,
            permission_level, grant_source, confirmed_by)
         SELECT DISTINCT $1, edm.user_id, 'event', $3, 'reports', 'view', 'assigned', $4::uuid
         FROM production_dept_member edm
         WHERE edm.dept_id = ANY($2::uuid[]) AND edm.is_poc
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
           WHERE is_revoked = false
         DO NOTHING`,
        [productionId, deptIds, eventId, assignedBy],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Production Events ────────────────────────────────────────────────────────

async function maybeAutoComplete(event: ProductionEvent): Promise<ProductionEvent> {
  if (event.status === "published" && event.endTime && new Date(event.endTime) < new Date()) {
    await getPool().query(
      `UPDATE production_event SET status = 'completed', updated_at = now() WHERE id = $1`,
      [event.id],
    );
    await completeAllEventTechReqs(event.id);
    return { ...event, status: "completed" };
  }
  return event;
}

export async function listProductionEvents(productionId: string): Promise<ProductionEvent[]> {
  const pool = getPool();
  const [eventsRes, smRes] = await Promise.all([
    pool.query<EventRow>(
      `SELECT id, production_id, title, event_type, location,
              start_time, end_time, status, description, chat_id, version_id,
              created_by, created_at, updated_at
       FROM production_event WHERE production_id = $1 ORDER BY start_time NULLS LAST, created_at`,
      [productionId]
    ),
    pool.query<{ event_id: string; user_id: string; name: string }>(
      `SELECT esm.event_id, esm.user_id, esm.name
       FROM event_stage_manager esm
       JOIN production_event pe ON pe.id = esm.event_id
       WHERE pe.production_id = $1`,
      [productionId]
    ),
  ]);
  const smMap = new Map<string, { userId: string; name: string }[]>();
  for (const r of smRes.rows) {
    if (!smMap.has(r.event_id)) smMap.set(r.event_id, []);
    smMap.get(r.event_id)!.push({ userId: r.user_id, name: r.name });
  }
  const events = eventsRes.rows.map(r => rowToEvent(r, smMap.get(r.id) ?? []));
  return Promise.all(events.map(maybeAutoComplete));
}

export async function getProductionEvent(id: string, productionId: string): Promise<ProductionEvent | null> {
  const pool = getPool();
  const [eventsRes, smRes] = await Promise.all([
    pool.query<EventRow>(
      `SELECT id, production_id, title, event_type, location,
              start_time, end_time, status, description, chat_id, version_id,
              created_by, created_at, updated_at
       FROM production_event WHERE id = $1 AND production_id = $2`,
      [id, productionId]
    ),
    pool.query<{ user_id: string; name: string }>(
      "SELECT user_id, name FROM event_stage_manager WHERE event_id = $1",
      [id]
    ),
  ]);
  if (!eventsRes.rows[0]) return null;
  const event = rowToEvent(eventsRes.rows[0], smRes.rows.map(r => ({ userId: r.user_id, name: r.name })));
  return maybeAutoComplete(event);
}

export async function setEventStageManagers(
  eventId: string,
  managers: { userId: string; name: string }[],
  productionId: string,
  assignedBy: string,
): Promise<void> {
  const seen = new Set<string>();
  const unique = managers.filter(m => { if (seen.has(m.userId)) return false; seen.add(m.userId); return true; });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_stage_manager WHERE event_id = $1", [eventId]);
    for (const m of unique) {
      await client.query(
        "INSERT INTO event_stage_manager (event_id, user_id, name) VALUES ($1,$2,$3)",
        [eventId, m.userId, m.name],
      );
    }
    // 跟组舞监自动行集（用户规范，无需发布即生效）：
    // details/call_sheet/tasks 可见 + 本 event 报告 CRUD。
    // 移除舞监不撤行（行是独立事实，撤销走 sweep/手动）。
    if (unique.length > 0) {
      await client.query(
        `INSERT INTO production_member_grant
           (production_id, user_id, resource_type, resource_id, resource_sub,
            permission_level, grant_source, confirmed_by)
         SELECT $1, u, 'event', $3, s.sub, s.verb, 'assigned', $4
         FROM unnest($2::uuid[]) AS u
         CROSS JOIN (VALUES
           ('meta', 'view'), ('details', 'view'), ('publication', 'view'),
           ('call_sheet', 'view'), ('call_sheet', 'edit'),
           ('tasks', 'view'), ('reports', 'view'),
           ('reports', 'create'), ('reports', 'edit'), ('reports', 'delete')
         ) AS s(sub, verb)
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
           WHERE is_revoked = false
         DO NOTHING`,
        [productionId, unique.map(m => m.userId), eventId, assignedBy],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createProductionEvent(data: {
  id: string; productionId: string; title: string; eventType: string;
  location: string; startTime: string | null; endTime: string | null;
  description: string; createdBy: string; versionId?: string | null;
}): Promise<ProductionEvent> {
  const res = await getPool().query<EventRow>(
    `INSERT INTO production_event
       (id, production_id, title, event_type, location, start_time, end_time, description, created_by, version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, production_id, title, event_type, location,
               start_time, end_time, status, description, chat_id, version_id,
               created_by, created_at, updated_at`,
    [data.id, data.productionId, data.title, data.eventType, data.location,
     data.startTime, data.endTime, data.description, data.createdBy, data.versionId ?? null]
  );
  await writeEventGrants(data.id, data.productionId, data.createdBy);
  return rowToEvent(res.rows[0]);
}

export async function updateProductionEvent(
  id: string, productionId: string,
  fields: {
    title?: string; eventType?: string; location?: string;
    startTime?: string | null; endTime?: string | null;
    status?: ProductionEvent["status"]; description?: string;
    versionId?: string | null;
  }
): Promise<ProductionEvent | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id, productionId];
  if (fields.title       !== undefined) sets.push(`title       = $${vals.push(fields.title)}`);
  if (fields.eventType   !== undefined) sets.push(`event_type  = $${vals.push(fields.eventType)}`);
  if (fields.location    !== undefined) sets.push(`location    = $${vals.push(fields.location)}`);
  if (fields.startTime   !== undefined) sets.push(`start_time  = $${vals.push(fields.startTime)}`);
  if (fields.endTime     !== undefined) sets.push(`end_time    = $${vals.push(fields.endTime)}`);
  if (fields.status      !== undefined) sets.push(`status      = $${vals.push(fields.status)}`);
  if (fields.description !== undefined) sets.push(`description = $${vals.push(fields.description)}`);
  if ("versionId" in fields)            sets.push(`version_id  = $${vals.push(fields.versionId ?? null)}`);
  if (!sets.length) return getProductionEvent(id, productionId);
  sets.push(`updated_at = now()`);
  const res = await getPool().query<EventRow>(
    `UPDATE production_event SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2
     RETURNING id, production_id, title, event_type, location,
               start_time, end_time, status, description, chat_id, version_id,
               created_by, created_at, updated_at`,
    vals
  );
  return res.rows[0] ? rowToEvent(res.rows[0]) : null;
}

export async function deleteProductionEvent(id: string, productionId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM production_event WHERE id = $1 AND production_id = $2",
    [id, productionId]
  );
}

// ─── Schedule Items ───────────────────────────────────────────────────────────

export async function listScheduleItems(eventId: string): Promise<EventScheduleItem[]> {
  const res = await getPool().query<ScheduleItemRow>(
    `SELECT id, event_id, title, item_type, start_time, end_time, location,
            order_index, target_scene_id, target_block_id, notes
     FROM event_schedule_item WHERE event_id = $1 ORDER BY order_index`,
    [eventId]
  );
  return res.rows.map(rowToScheduleItem);
}

export async function getScheduleItem(id: string, eventId: string): Promise<EventScheduleItem | null> {
  const res = await getPool().query<ScheduleItemRow>(
    `SELECT id, event_id, title, item_type, start_time, end_time, location,
            order_index, target_scene_id, target_block_id, notes
     FROM event_schedule_item WHERE id = $1 AND event_id = $2`,
    [id, eventId]
  );
  return res.rows[0] ? rowToScheduleItem(res.rows[0]) : null;
}

export async function createScheduleItem(data: {
  id: string; eventId: string; title: string; itemType: string;
  startTime: string | null; endTime: string | null; location: string;
  orderIndex: number; targetSceneId: string | null;
  targetBlockId: string | null; notes: string;
}): Promise<EventScheduleItem> {
  const res = await getPool().query<ScheduleItemRow>(
    `INSERT INTO event_schedule_item
       (id, event_id, title, item_type, start_time, end_time, location,
        order_index, target_scene_id, target_block_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, event_id, title, item_type, start_time, end_time, location,
               order_index, target_scene_id, target_block_id, notes`,
    [data.id, data.eventId, data.title, data.itemType, data.startTime, data.endTime,
     data.location, data.orderIndex, data.targetSceneId, data.targetBlockId, data.notes]
  );
  return rowToScheduleItem(res.rows[0]);
}

export async function updateScheduleItem(
  id: string, eventId: string,
  fields: {
    title?: string; itemType?: string; startTime?: string | null;
    endTime?: string | null; location?: string; orderIndex?: number;
    targetSceneId?: string | null; targetBlockId?: string | null; notes?: string;
  }
): Promise<EventScheduleItem | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id, eventId];
  if (fields.title        !== undefined) sets.push(`title          = $${vals.push(fields.title)}`);
  if (fields.itemType     !== undefined) sets.push(`item_type      = $${vals.push(fields.itemType)}`);
  if (fields.startTime    !== undefined) sets.push(`start_time     = $${vals.push(fields.startTime)}`);
  if (fields.endTime      !== undefined) sets.push(`end_time       = $${vals.push(fields.endTime)}`);
  if (fields.location     !== undefined) sets.push(`location       = $${vals.push(fields.location)}`);
  if (fields.orderIndex   !== undefined) sets.push(`order_index    = $${vals.push(fields.orderIndex)}`);
  if (fields.targetSceneId !== undefined) sets.push(`target_scene_id = $${vals.push(fields.targetSceneId)}`);
  if (fields.targetBlockId !== undefined) sets.push(`target_block_id = $${vals.push(fields.targetBlockId)}`);
  if (fields.notes        !== undefined) sets.push(`notes          = $${vals.push(fields.notes)}`);
  if (!sets.length) return getScheduleItem(id, eventId);
  const res = await getPool().query<ScheduleItemRow>(
    `UPDATE event_schedule_item SET ${sets.join(", ")} WHERE id = $1 AND event_id = $2
     RETURNING id, event_id, title, item_type, start_time, end_time, location,
               order_index, target_scene_id, target_block_id, notes`,
    vals
  );
  return res.rows[0] ? rowToScheduleItem(res.rows[0]) : null;
}

export async function deleteScheduleItem(id: string, eventId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM event_schedule_item WHERE id = $1 AND event_id = $2",
    [id, eventId]
  );
}

// Replaces order_index for all items in one query using a VALUES list.
export async function reorderScheduleItems(
  eventId: string, orderedIds: string[]
): Promise<void> {
  if (!orderedIds.length) return;
  const values = orderedIds.map((oid, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::int)`).join(", ");
  const params: unknown[] = orderedIds.flatMap((oid, i) => [oid, i]);
  await getPool().query(
    `UPDATE event_schedule_item AS esi
     SET order_index = v.ord
     FROM (VALUES ${values}) AS v(id, ord)
     WHERE esi.id = v.id AND esi.event_id = $${params.push(eventId)}`,
    params
  );
}

// ─── Schedule item participants ───────────────────────────────────────────────

export async function listScheduleItemParticipants(itemId: string): Promise<ScheduleItemParticipant[]> {
  const res = await getPool().query<{ user_id: string; name: string }>(
    "SELECT user_id, name FROM schedule_item_participant WHERE item_id = $1 ORDER BY name",
    [itemId]
  );
  return res.rows.map(r => ({ userId: r.user_id, name: r.name }));
}

export async function setScheduleItemParticipants(
  itemId: string,
  participants: ScheduleItemParticipant[],
): Promise<void> {
  const seen = new Set<string>();
  const unique = participants.filter(p => { if (seen.has(p.userId)) return false; seen.add(p.userId); return true; });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM schedule_item_participant WHERE item_id = $1", [itemId]);
    for (const p of unique) {
      await client.query(
        "INSERT INTO schedule_item_participant (item_id, user_id, name) VALUES ($1,$2,$3)",
        [itemId, p.userId, p.name],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Load all schedule items for an event with their participant lists and department associations. */
export async function listScheduleItemsWithParticipants(
  eventId: string,
): Promise<EventScheduleItemWithParticipants[]> {
  const pool = getPool();
  const [itemRes, partRes, deptRes] = await Promise.all([
    pool.query<ScheduleItemRow>(
      `SELECT id, event_id, title, item_type, start_time, end_time, location,
              order_index, target_scene_id, target_block_id, notes
       FROM event_schedule_item WHERE event_id = $1 ORDER BY order_index`,
      [eventId]
    ),
    pool.query<{ item_id: string; user_id: string; name: string }>(
      `SELECT sip.item_id, sip.user_id, sip.name
       FROM schedule_item_participant sip
       JOIN event_schedule_item esi ON esi.id = sip.item_id
       WHERE esi.event_id = $1`,
      [eventId]
    ),
    pool.query<{ item_id: string; dept_id: string }>(
      `SELECT sid.item_id, sid.dept_id
       FROM schedule_item_department sid
       JOIN event_schedule_item esi ON esi.id = sid.item_id
       WHERE esi.event_id = $1`,
      [eventId]
    ),
  ]);
  const partMap = new Map<string, ScheduleItemParticipant[]>();
  for (const r of partRes.rows) {
    if (!partMap.has(r.item_id)) partMap.set(r.item_id, []);
    partMap.get(r.item_id)!.push({ userId: r.user_id, name: r.name });
  }
  const deptMap = new Map<string, string[]>();
  for (const r of deptRes.rows) {
    if (!deptMap.has(r.item_id)) deptMap.set(r.item_id, []);
    deptMap.get(r.item_id)!.push(r.dept_id);
  }
  return itemRes.rows.map(r => ({
    ...rowToScheduleItem(r),
    participants: partMap.get(r.id) ?? [],
    departmentIds: deptMap.get(r.id) ?? [],
  }));
}

export async function setScheduleItemDepartments(
  itemId: string,
  deptIds: string[],
): Promise<void> {
  const unique = [...new Set(deptIds)];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM schedule_item_department WHERE item_id = $1", [itemId]);
    for (const deptId of unique) {
      await client.query(
        "INSERT INTO schedule_item_department (item_id, dept_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [itemId, deptId],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Distinct people across all schedule items + tech req assignees for an event. */
export async function listEventPeople(eventId: string): Promise<{ userId: string; name: string }[]> {
  const res = await getPool().query<{ user_id: string; name: string }>(
    `SELECT DISTINCT p.user_id, p.name
     FROM schedule_item_participant p
     JOIN event_schedule_item esi ON esi.id = p.item_id
     WHERE esi.event_id = $1
     UNION
     SELECT a.user_id, a.name
     FROM event_tech_assignee a
     JOIN event_tech_req tr ON tr.id = a.req_id
     WHERE tr.event_id = $1 AND tr.status != 'awaiting'
     ORDER BY name`,
    [eventId]
  );
  return res.rows.map(r => ({ userId: r.user_id, name: r.name }));
}

// ─── Participants / Followers ─────────────────────────────────────────────────

export async function listEventParticipants(eventId: string): Promise<EventParticipant[]> {
  const res = await getPool().query<ParticipantRow>(
    `SELECT id, event_id, user_id, name, department_id, role
     FROM event_participant WHERE event_id = $1 ORDER BY role, name`,
    [eventId]
  );
  return res.rows.map(rowToParticipant);
}

export async function upsertEventParticipant(data: {
  id: string; eventId: string; userId: string; name: string;
  departmentId: string | null; role: "participant" | "follower";
}): Promise<EventParticipant> {
  const res = await getPool().query<ParticipantRow>(
    `INSERT INTO event_participant (id, event_id, user_id, name, department_id, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id, user_id) DO UPDATE
       SET name = EXCLUDED.name, department_id = EXCLUDED.department_id, role = EXCLUDED.role
     RETURNING id, event_id, user_id, name, department_id, role`,
    [data.id, data.eventId, data.userId, data.name, data.departmentId, data.role]
  );
  return rowToParticipant(res.rows[0]);
}

export async function removeEventParticipant(eventId: string, userId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM event_participant WHERE event_id = $1 AND user_id = $2",
    [eventId, userId]
  );
}

export async function isEventFollower(eventId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_participant WHERE event_id = $1 AND user_id = $2
     ) AS exists`,
    [eventId, userId]
  );
  return res.rows[0].exists;
}

// Returns the department_ids this user is assigned to as a participant in an event.
export async function getParticipantDeptIds(eventId: string, userId: string): Promise<string[]> {
  const res = await getPool().query<{ department_id: string }>(
    `SELECT department_id FROM event_participant
     WHERE event_id = $1 AND user_id = $2 AND department_id IS NOT NULL`,
    [eventId, userId]
  );
  return res.rows.map(r => r.department_id);
}

// ─── Call Times ───────────────────────────────────────────────────────────────

export async function listEventCallTimes(eventId: string): Promise<EventCallTime[]> {
  const res = await getPool().query<CallTimeRow>(
    `SELECT id, event_id, user_id, name, department_id, call_at, schedule_item_id, notes
     FROM event_call_time WHERE event_id = $1 ORDER BY call_at, name`,
    [eventId]
  );
  return res.rows.map(rowToCallTime);
}

export async function createEventCallTime(data: {
  id: string; eventId: string; userId: string; name: string;
  departmentId: string | null; callAt: string;
  scheduleItemId: string | null; notes: string;
}): Promise<EventCallTime> {
  const res = await getPool().query<CallTimeRow>(
    `INSERT INTO event_call_time
       (id, event_id, user_id, name, department_id, call_at, schedule_item_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, event_id, user_id, name, department_id, call_at, schedule_item_id, notes`,
    [data.id, data.eventId, data.userId, data.name, data.departmentId,
     data.callAt, data.scheduleItemId, data.notes]
  );
  return rowToCallTime(res.rows[0]);
}

export async function updateEventCallTime(
  id: string, eventId: string,
  fields: {
    name?: string; departmentId?: string | null; callAt?: string;
    scheduleItemId?: string | null; notes?: string;
  }
): Promise<EventCallTime | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id, eventId];
  if (fields.name           !== undefined) sets.push(`name             = $${vals.push(fields.name)}`);
  if (fields.departmentId   !== undefined) sets.push(`department_id    = $${vals.push(fields.departmentId)}`);
  if (fields.callAt         !== undefined) sets.push(`call_at          = $${vals.push(fields.callAt)}`);
  if (fields.scheduleItemId !== undefined) sets.push(`schedule_item_id = $${vals.push(fields.scheduleItemId)}`);
  if (fields.notes          !== undefined) sets.push(`notes            = $${vals.push(fields.notes)}`);
  if (!sets.length) return null;
  const res = await getPool().query<CallTimeRow>(
    `UPDATE event_call_time SET ${sets.join(", ")} WHERE id = $1 AND event_id = $2
     RETURNING id, event_id, user_id, name, department_id, call_at, schedule_item_id, notes`,
    vals
  );
  return res.rows[0] ? rowToCallTime(res.rows[0]) : null;
}

export async function deleteEventCallTime(id: string, eventId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM event_call_time WHERE id = $1 AND event_id = $2",
    [id, eventId]
  );
}

// ─── Tech Requirements ────────────────────────────────────────────────────────

export async function listEventTechReqs(eventId: string): Promise<EventTechReq[]> {
  const pool = getPool();
  const [reqRes, assigneeRes, itemRes] = await Promise.all([
    pool.query<TechReqRow>(
      `SELECT id, event_id, title, description,
              preset_minutes, department_id, status, chat_id, created_via, created_at
       FROM event_tech_req WHERE event_id = $1 ORDER BY created_at`,
      [eventId]
    ),
    pool.query<TechAssigneeRow>(
      `SELECT eta.req_id, eta.user_id, eta.name
       FROM event_tech_assignee eta
       JOIN event_tech_req etr ON etr.id = eta.req_id
       WHERE etr.event_id = $1`,
      [eventId]
    ),
    pool.query<{ req_id: string; item_id: string }>(
      `SELECT etri.req_id, etri.item_id
       FROM event_tech_req_item etri
       JOIN event_tech_req etr ON etr.id = etri.req_id
       WHERE etr.event_id = $1`,
      [eventId]
    ),
  ]);
  const assigneeMap = new Map<string, EventTechReqAssignee[]>();
  for (const r of assigneeRes.rows) {
    if (!assigneeMap.has(r.req_id)) assigneeMap.set(r.req_id, []);
    assigneeMap.get(r.req_id)!.push({ userId: r.user_id, name: r.name });
  }
  const itemMap = new Map<string, string[]>();
  for (const r of itemRes.rows) {
    if (!itemMap.has(r.req_id)) itemMap.set(r.req_id, []);
    itemMap.get(r.req_id)!.push(r.item_id);
  }
  return reqRes.rows.map(r => rowToTechReq(r, assigneeMap.get(r.id) ?? [], itemMap.get(r.id) ?? []));
}

export async function getEventTechReq(id: string, eventId: string): Promise<EventTechReq | null> {
  const pool = getPool();
  const [reqRes, assigneeRes, itemRes] = await Promise.all([
    pool.query<TechReqRow>(
      `SELECT id, event_id, title, description,
              preset_minutes, department_id, status, chat_id, created_via, created_at
       FROM event_tech_req WHERE id = $1 AND event_id = $2`,
      [id, eventId]
    ),
    pool.query<TechAssigneeRow>(
      "SELECT req_id, user_id, name FROM event_tech_assignee WHERE req_id = $1",
      [id]
    ),
    pool.query<{ item_id: string }>(
      "SELECT item_id FROM event_tech_req_item WHERE req_id = $1",
      [id]
    ),
  ]);
  if (!reqRes.rows[0]) return null;
  return rowToTechReq(
    reqRes.rows[0],
    assigneeRes.rows.map(r => ({ userId: r.user_id, name: r.name })),
    itemRes.rows.map(r => r.item_id),
  );
}

export async function getTechReqByProduction(id: string, productionId: string): Promise<EventTechReq | null> {
  const pool = getPool();
  const [reqRes, assigneeRes, itemRes] = await Promise.all([
    pool.query<TechReqRow>(
      `SELECT etr.id, etr.event_id, etr.title, etr.description,
              etr.preset_minutes, etr.department_id, etr.status, etr.chat_id, etr.created_at
       FROM event_tech_req etr
       JOIN production_event pe ON pe.id = etr.event_id
       WHERE etr.id = $1 AND pe.production_id = $2`,
      [id, productionId]
    ),
    pool.query<TechAssigneeRow>(
      "SELECT req_id, user_id, name FROM event_tech_assignee WHERE req_id = $1",
      [id]
    ),
    pool.query<{ item_id: string }>(
      "SELECT item_id FROM event_tech_req_item WHERE req_id = $1",
      [id]
    ),
  ]);
  if (!reqRes.rows[0]) return null;
  return rowToTechReq(
    reqRes.rows[0],
    assigneeRes.rows.map(r => ({ userId: r.user_id, name: r.name })),
    itemRes.rows.map(r => r.item_id),
  );
}

export async function setTechReqItems(reqId: string, itemIds: string[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_tech_req_item WHERE req_id = $1", [reqId]);
    const unique = [...new Set(itemIds)];
    for (const itemId of unique) {
      await client.query(
        "INSERT INTO event_tech_req_item (req_id, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [reqId, itemId]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createEventTechReq(data: {
  id: string; eventId: string; scheduleItemIds: string[];
  title: string; description: string; presetMinutes: number | null;
  departmentId: string | null; assignees: EventTechReqAssignee[];
  createdVia?: "explicit" | "poc";
  createdBy: string;
}): Promise<EventTechReq> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<TechReqRow>(
      `INSERT INTO event_tech_req
         (id, event_id, title, description, preset_minutes, department_id, created_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, event_id, title, description,
                 preset_minutes, department_id, status, chat_id, created_via, created_at`,
      [data.id, data.eventId, data.title, data.description, data.presetMinutes, data.departmentId, data.createdVia ?? "explicit"]
    );
    const unique = [...new Set(data.scheduleItemIds)];
    for (const itemId of unique) {
      await client.query(
        "INSERT INTO event_tech_req_item (req_id, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [data.id, itemId]
      );
    }
    for (const a of data.assignees) {
      await client.query(
        "INSERT INTO event_tech_assignee (req_id, user_id, name) VALUES ($1,$2,$3)",
        [data.id, a.userId, a.name]
      );
    }
    await client.query("COMMIT");
    // Write resource grants after transaction commit (best-effort; failures don't roll back the req)
    const prodRow = await getPool().query<{ production_id: string }>(
      "SELECT production_id FROM production_event WHERE id = $1", [data.eventId]
    );
    if (prodRow.rows[0]) {
      await writeTechReqGrants(data.id, prodRow.rows[0].production_id, data.departmentId, data.createdBy, data.eventId);
      if (data.departmentId) {
        await writeTaskDeptEventVisibility(data.eventId, data.departmentId, prodRow.rows[0].production_id, data.createdBy);
      }
    }
    return rowToTechReq(res.rows[0], data.assignees, unique);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateEventTechReq(
  id: string, eventId: string,
  fields: {
    title?: string; description?: string;
    presetMinutes?: number | null; departmentId?: string | null; status?: string;
  }
): Promise<EventTechReq | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id, eventId];
  if (fields.title         !== undefined) sets.push(`title          = $${vals.push(fields.title)}`);
  if (fields.description   !== undefined) sets.push(`description    = $${vals.push(fields.description)}`);
  if (fields.presetMinutes !== undefined) sets.push(`preset_minutes = $${vals.push(fields.presetMinutes)}`);
  if (fields.departmentId  !== undefined) sets.push(`department_id  = $${vals.push(fields.departmentId)}`);
  if (fields.status        !== undefined) sets.push(`status         = $${vals.push(fields.status)}`);
  if (!sets.length) return getEventTechReq(id, eventId);
  const res = await getPool().query<TechReqRow>(
    `UPDATE event_tech_req SET ${sets.join(", ")} WHERE id = $1 AND event_id = $2
     RETURNING id, event_id, title, description,
               preset_minutes, department_id, status, chat_id, created_via, created_at`,
    vals
  );
  if (!res.rows[0]) return null;
  const [assigneeRes, itemRes] = await Promise.all([
    getPool().query<TechAssigneeRow>(
      "SELECT req_id, user_id, name FROM event_tech_assignee WHERE req_id = $1", [id]
    ),
    getPool().query<{ item_id: string }>(
      "SELECT item_id FROM event_tech_req_item WHERE req_id = $1", [id]
    ),
  ]);
  return rowToTechReq(
    res.rows[0],
    assigneeRes.rows.map(r => ({ userId: r.user_id, name: r.name })),
    itemRes.rows.map(r => r.item_id),
  );
}

export async function deleteEventTechReq(id: string, eventId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM event_tech_req WHERE id = $1 AND event_id = $2",
    [id, eventId]
  );
}

/**
 * For each departmentId, find the existing 'awaiting' tech req for that dept in the event,
 * and add scheduleItemId to it (if given). If no awaiting req exists, create a blank one.
 * Content already filled in is preserved. Returns the upserted reqs.
 */
export async function upsertAwaitingTechReqs(
  eventId: string,
  departmentIds: string[],
  scheduleItemId?: string,
): Promise<EventTechReq[]> {
  const pool = getPool();
  const result: EventTechReq[] = [];
  let seq = 0;
  const uid = () => `tr${Date.now().toString(36)}${(++seq).toString(36)}`;

  for (const deptId of departmentIds) {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM event_tech_req WHERE event_id = $1 AND department_id = $2 AND status = 'awaiting'`,
      [eventId, deptId],
    );

    let reqId: string;
    if (existing.rows.length > 0) {
      reqId = existing.rows[0].id;
      if (scheduleItemId) {
        await pool.query(
          `INSERT INTO event_tech_req_item (req_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [reqId, scheduleItemId],
        );
      }
    } else {
      reqId = uid();
      await pool.query(
        `INSERT INTO event_tech_req (id, event_id, title, description, department_id, status, created_via)
         VALUES ($1, $2, '', '', $3, 'awaiting', 'dept_auto')`,
        [reqId, eventId, deptId],
      );
      if (scheduleItemId) {
        await pool.query(
          `INSERT INTO event_tech_req_item (req_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [reqId, scheduleItemId],
        );
      }
    }

    const req = await getEventTechReq(reqId, eventId);
    if (req) result.push(req);
  }

  // 规则4：部门被 assign（dept_auto 路径）→ event 可见性行
  const prodRow = await pool.query<{ production_id: string; created_by: string }>(
    "SELECT production_id, created_by FROM production_event WHERE id = $1", [eventId],
  );
  if (prodRow.rows[0]) {
    for (const deptId of departmentIds) {
      await writeTaskDeptEventVisibility(eventId, deptId, prodRow.rows[0].production_id, prodRow.rows[0].created_by);
    }
  }

  return result;
}

/** 部门被 assign 进 tech req（任何路径）时的 event 可见性行（用户规则4）：
 *  POC = meta+details+publication view（提前确认/组织）；成员 = meta+details view
 *  （发布后可见）。物化当下成员（模板只是模板）；解绑不撤行。 */
export async function writeTaskDeptEventVisibility(
  eventId: string,
  eventDeptId: string,
  productionId: string,
  establishedBy: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     SELECT $1, edm.user_id, 'event', $2, s.sub, 'view', 'assigned', $4
     FROM production_dept_member edm
     CROSS JOIN LATERAL (
       -- POC 追加 publication（提前确认/组织）+ reports（draft report 可见，批C C3）
       SELECT sub FROM (VALUES ('meta'), ('details'), ('publication'), ('reports')) AS v(sub)
       WHERE edm.is_poc OR v.sub NOT IN ('publication', 'reports')
     ) AS s
     WHERE edm.dept_id = $3
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false
     DO NOTHING`,
    [productionId, eventId, eventDeptId, establishedBy],
  );
}

export async function completeAllEventTechReqs(eventId: string): Promise<void> {
  await getPool().query(
    "UPDATE event_tech_req SET status = 'done' WHERE event_id = $1 AND status != 'done'",
    [eventId]
  );
}

export async function setTechReqAssignees(
  reqId: string, assignees: EventTechReqAssignee[]
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_tech_assignee WHERE req_id = $1", [reqId]);
    for (const a of assignees) {
      await client.query(
        "INSERT INTO event_tech_assignee (req_id, user_id, name) VALUES ($1,$2,$3)",
        [reqId, a.userId, a.name]
      );
    }
    // 被 assign 进绑定 event 的 task = 被叫来干活（技术需求 call，与 calltime 同族）
    // → 自动获得该 event 的 meta+details@view assigned 行（严格剧组下也能看到
    // 排练时间地点）。不写 event_participant（名单是 organizer 的产品面）；
    // 移除 assignee 不撤行（行是独立事实）。
    if (assignees.length > 0) {
      await client.query(
        `INSERT INTO production_member_grant
           (production_id, user_id, resource_type, resource_id, resource_sub,
            permission_level, grant_source, confirmed_by)
         SELECT pe.production_id, u, 'event', pe.id, s.sub, 'view', 'assigned', u
         FROM event_tech_req etr
         JOIN production_event pe ON pe.id = etr.event_id
         CROSS JOIN unnest($2::uuid[]) AS u
         CROSS JOIN (VALUES ('meta'), ('details'), ('publication')) AS s(sub)
         WHERE etr.id = $1
         ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
           WHERE is_revoked = false
         DO NOTHING`,
        [reqId, assignees.map(a => a.userId)],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Reports ──────────────────────────────────────────────────────────────────

export async function listEventReports(eventId: string): Promise<EventReport[]> {
  const res = await getPool().query<ReportRow>(
    `SELECT er.id, er.event_id, er.report_type, w.title, w.body, w.created_by,
            er.created_at, er.updated_at, er.published_at, w.mentions
     FROM event_report er JOIN wiki w ON w.id = er.wiki_id
     WHERE er.event_id = $1 ORDER BY er.created_at`,
    [eventId]
  );
  return res.rows.map(rowToReport);
}

export async function getEventReport(id: string, eventId: string): Promise<EventReport | null> {
  const res = await getPool().query<ReportRow>(
    `SELECT er.id, er.event_id, er.report_type, w.title, w.body, w.created_by,
            er.created_at, er.updated_at, er.published_at, w.mentions
     FROM event_report er JOIN wiki w ON w.id = er.wiki_id
     WHERE er.id = $1 AND er.event_id = $2`,
    [id, eventId]
  );
  return res.rows[0] ? rowToReport(res.rows[0]) : null;
}

export async function getReportByProduction(id: string, productionId: string): Promise<EventReport | null> {
  const res = await getPool().query<ReportRow>(
    `SELECT er.id, er.event_id, er.report_type, w.title, w.body, w.created_by,
            er.created_at, er.updated_at, er.published_at, w.mentions
     FROM event_report er
     JOIN wiki w ON w.id = er.wiki_id
     JOIN production_event pe ON pe.id = er.event_id
     WHERE er.id = $1 AND pe.production_id = $2`,
    [id, productionId]
  );
  return res.rows[0] ? rowToReport(res.rows[0]) : null;
}

export async function createEventReport(data: {
  id: string; eventId: string; reportType: string;
  title: string; body: string; createdBy: string;
}): Promise<EventReport> {
  // 拆分模型：wiki=内容实体、event_report=挂载边（id 即边 id）
  const client = await getPool().connect();
  let row: ReportRow;
  try {
    await client.query("BEGIN");
    const prodRow = await client.query<{ production_id: string }>(
      "SELECT production_id FROM production_event WHERE id = $1", [data.eventId]
    );
    if (!prodRow.rows[0]) throw new Error(`event not found: ${data.eventId}`);
    const wikiRow = await client.query<{ id: string }>(
      `INSERT INTO wiki (production_id, title, body, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [prodRow.rows[0].production_id, data.title, data.body, data.createdBy]
    );
    const res = await client.query<ReportRow>(
      `INSERT INTO event_report (id, event_id, report_type, wiki_id)
       VALUES ($1,$2,$3,$4)
       RETURNING id, event_id, report_type, created_at, updated_at, published_at`,
      [data.id, data.eventId, data.reportType, wikiRow.rows[0].id]
    );
    await client.query("COMMIT");
    row = { ...res.rows[0], title: data.title, body: data.body, created_by: data.createdBy, mentions: [] } as ReportRow;
    await writeReportGrants(data.id, prodRow.rows[0].production_id, data.createdBy, data.eventId);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return rowToReport(row);
}

export async function updateEventReport(
  id: string, eventId: string,
  fields: {
    reportType?: string; title?: string; body?: string;
    publishedAt?: string | null; mentions?: Mention[];
  }
): Promise<EventReport | null> {
  // 拆分模型：title/body/mentions → wiki 实体；report_type/published_at → 边
  const edgeSets: string[] = [];
  const edgeVals: unknown[] = [id, eventId];
  if (fields.reportType  !== undefined) edgeSets.push(`report_type  = $${edgeVals.push(fields.reportType)}`);
  if (fields.publishedAt !== undefined) edgeSets.push(`published_at = $${edgeVals.push(fields.publishedAt)}`);
  const wikiSets: string[] = [];
  const wikiVals: unknown[] = [id, eventId];
  if (fields.title    !== undefined) wikiSets.push(`title    = $${wikiVals.push(fields.title)}`);
  if (fields.body     !== undefined) wikiSets.push(`body     = $${wikiVals.push(fields.body)}`);
  if (fields.mentions !== undefined) wikiSets.push(`mentions = $${wikiVals.push(JSON.stringify(fields.mentions))}`);
  if (!edgeSets.length && !wikiSets.length) return getEventReport(id, eventId);
  if (edgeSets.length) {
    edgeSets.push(`updated_at = now()`);
    await getPool().query(
      `UPDATE event_report SET ${edgeSets.join(", ")} WHERE id = $1 AND event_id = $2`, edgeVals,
    );
  }
  if (wikiSets.length) {
    wikiSets.push(`updated_at = now()`);
    await getPool().query(
      `UPDATE wiki SET ${wikiSets.join(", ")}
       WHERE id = (SELECT wiki_id FROM event_report WHERE id = $1 AND event_id = $2)`, wikiVals,
    );
  }
  return getEventReport(id, eventId);
}

export async function deleteEventReport(id: string, eventId: string): Promise<void> {
  // 边删除 + 内容实体删除（wiki 独立文档库上线前，report 内容随边生灭）
  await getPool().query(
    `WITH edge AS (DELETE FROM event_report WHERE id = $1 AND event_id = $2 RETURNING wiki_id)
     DELETE FROM wiki WHERE id IN (SELECT wiki_id FROM edge)`,
    [id, eventId]
  );
}

// ─── Report Notes ─────────────────────────────────────────────────────────────

export async function listReportNotes(reportId: string): Promise<EventReportNote[]> {
  const res = await getPool().query<ReportNoteRow>(
    `SELECT n.id, n.report_id, n.department_id, w.body AS content, w.created_by AS author_user_id,
            COALESCE(up.name, '') AS author_name, n.created_at, n.updated_at, w.mentions, n.created_via
     FROM event_report_note n
     JOIN wiki w ON w.id = n.wiki_id
     LEFT JOIN user_profile up ON up.user_id = w.created_by
     WHERE n.report_id = $1 ORDER BY n.created_at`,
    [reportId]
  );
  return res.rows.map(rowToReportNote);
}

export async function createReportNote(data: {
  id: string; reportId: string; departmentId: string;
  content: string; authorUserId: string; authorName: string;
  mentions?: Mention[]; createdVia: "dept" | "wildcard" | "moderator";
}): Promise<EventReportNote> {
  // 拆分模型：note 内容进 wiki 实体，边表只存 (report, wiki, dept) 联合关系
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const wikiRow = await client.query<{ id: string }>(
      `INSERT INTO wiki (production_id, body, mentions, created_by)
       SELECT pe.production_id, $1, $2, $3
       FROM event_report er JOIN production_event pe ON pe.id = er.event_id
       WHERE er.id = $4
       RETURNING id`,
      [data.content, JSON.stringify(data.mentions ?? []), data.authorUserId, data.reportId]
    );
    await client.query(
      `INSERT INTO event_report_note (id, report_id, department_id, wiki_id, created_via)
       VALUES ($1,$2,$3,$4,$5)`,
      [data.id, data.reportId, data.departmentId, wikiRow.rows[0].id, data.createdVia]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return (await getReportNote(data.id, data.reportId))!;
}

export async function updateReportNote(
  id: string, reportId: string, content: string, mentions?: Mention[]
): Promise<EventReportNote | null> {
  const sets = ["body = $1", "updated_at = now()"];
  const vals: unknown[] = [content, id, reportId];
  if (mentions !== undefined) {
    sets.push(`mentions = $${vals.push(JSON.stringify(mentions))}`);
  }
  await getPool().query(
    `UPDATE wiki SET ${sets.join(", ")}
     WHERE id = (SELECT wiki_id FROM event_report_note WHERE id = $2 AND report_id = $3)`,
    vals
  );
  await getPool().query(
    `UPDATE event_report_note SET updated_at = now() WHERE id = $1 AND report_id = $2`,
    [id, reportId]
  );
  return getReportNote(id, reportId);
}

export async function deleteReportNote(
  id: string, reportId: string, userId: string, isAdmin: boolean
): Promise<boolean> {
  // 作者判定在 wiki.created_by；边+内容一并删
  const res = isAdmin
    ? await getPool().query(
        `WITH edge AS (DELETE FROM event_report_note WHERE id = $1 AND report_id = $2 RETURNING wiki_id)
         DELETE FROM wiki WHERE id IN (SELECT wiki_id FROM edge) RETURNING id`,
        [id, reportId]
      )
    : await getPool().query(
        `WITH edge AS (
           DELETE FROM event_report_note n USING wiki w
           WHERE n.id = $1 AND n.report_id = $2 AND n.wiki_id = w.id AND w.created_by = $3
           RETURNING n.wiki_id
         )
         DELETE FROM wiki WHERE id IN (SELECT wiki_id FROM edge) RETURNING id`,
        [id, reportId, userId]
      );
  return res.rows.length > 0;
}

export async function getReportNote(id: string, reportId: string): Promise<EventReportNote | null> {
  const res = await getPool().query<ReportNoteRow>(
    `SELECT n.id, n.report_id, n.department_id, w.body AS content, w.created_by AS author_user_id,
            COALESCE(up.name, '') AS author_name, n.created_at, n.updated_at, w.mentions, n.created_via
     FROM event_report_note n
     JOIN wiki w ON w.id = n.wiki_id
     LEFT JOIN user_profile up ON up.user_id = w.created_by
     WHERE n.id = $1 AND n.report_id = $2`,
    [id, reportId]
  );
  return res.rows[0] ? rowToReportNote(res.rows[0]) : null;
}

/** Collect all unique userIds mentioned across a report's body and all its notes (JSONB). */
export async function listAllReportMentionedUserIds(reportId: string): Promise<string[]> {
  const pool = getPool();
  const [rptRes, noteRes] = await Promise.all([
    pool.query<{ user_id: string }>(
      `SELECT jsonb_array_elements(w.mentions)->>'userId' AS user_id FROM event_report er JOIN wiki w ON w.id = er.wiki_id WHERE er.id = $1`,
      [reportId],
    ),
    pool.query<{ user_id: string }>(
      `SELECT jsonb_array_elements(w.mentions)->>'userId' AS user_id FROM event_report_note n JOIN wiki w ON w.id = n.wiki_id WHERE n.report_id = $1`,
      [reportId],
    ),
  ]);
  const ids = new Set<string>();
  for (const { user_id } of [...rptRes.rows, ...noteRes.rows]) {
    if (user_id) ids.add(user_id);
  }
  return [...ids];
}

// ─── Report read receipts ─────────────────────────────────────────────────────

export async function markReportRead(reportId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO event_report_read (report_id, user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [reportId, userId]
  );
}

export async function listUnreadFollowedReports(userId: string, productionId?: string): Promise<UnreadReportEntry[]> {
  const params: unknown[] = [userId];
  const prodFilter = productionId ? `AND pe.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{
    report_id: string; report_title: string; published_at: Date | null;
    event_id: string; event_title: string; production_id: string; production_name: string;
  }>(
    `SELECT er.id AS report_id, w.title AS report_title, er.published_at,
            pe.id AS event_id, pe.title AS event_title,
            pe.production_id, p.name AS production_name
     FROM event_report er
     JOIN wiki w ON w.id = er.wiki_id
     JOIN production_event pe ON pe.id = er.event_id
     JOIN production p ON p.id = pe.production_id
     WHERE (
       er.published_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM event_report_read err
         WHERE err.report_id = er.id AND err.user_id = $1
       )
       AND (
         EXISTS (SELECT 1 FROM event_participant WHERE event_id = pe.id AND user_id = $1)
         OR EXISTS (SELECT 1 FROM event_call_time WHERE event_id = pe.id AND user_id = $1)
         OR w.mentions @> jsonb_build_array(jsonb_build_object('userId', $1::text))
       )
       ${prodFilter}
     ) OR (
       er.published_at IS NULL
       AND pe.status = 'completed'
       AND (
         pe.created_by = $1
         OR EXISTS (SELECT 1 FROM event_stage_manager WHERE event_id = pe.id AND user_id = $1)
       )
       ${prodFilter}
     )
     ORDER BY er.published_at DESC NULLS LAST
     LIMIT 20`,
    params
  );
  return res.rows.map(r => ({
    reportId: r.report_id,
    reportTitle: r.report_title,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    eventId: r.event_id,
    eventTitle: r.event_title,
    productionId: r.production_id,
    productionName: r.production_name,
  }));
}

export type MyReportEntry = {
  reportId: string;
  title: string;
  reportType: string;
  /** null for draft reports */
  publishedAt: string | null;
  eventId: string;
  eventTitle: string;
  productionId: string;
  productionName: string;
  isRead: boolean;
};

export async function listMyReports(userId: string): Promise<MyReportEntry[]> {
  const res = await getPool().query<{
    report_id: string; report_title: string; report_type: string; published_at: Date | null;
    event_id: string; event_title: string; production_id: string; production_name: string;
    is_read: boolean;
  }>(
    `SELECT er.id AS report_id, w.title AS report_title, er.report_type,
            er.published_at,
            pe.id AS event_id, pe.title AS event_title,
            pe.production_id, p.name AS production_name,
            EXISTS (
              SELECT 1 FROM event_report_read err
              WHERE err.report_id = er.id AND err.user_id = $1
            ) AS is_read
     FROM event_report er
     JOIN wiki w ON w.id = er.wiki_id
     JOIN production_event pe ON pe.id = er.event_id
     JOIN production p ON p.id = pe.production_id
     WHERE (
       er.published_at IS NOT NULL
       AND (
         EXISTS (SELECT 1 FROM event_participant WHERE event_id = pe.id AND user_id = $1)
         OR EXISTS (SELECT 1 FROM event_call_time WHERE event_id = pe.id AND user_id = $1)
         OR w.mentions @> jsonb_build_array(jsonb_build_object('userId', $1::text))
       )
     ) OR (
       er.published_at IS NULL
       AND pe.status = 'completed'
       AND (
         pe.created_by = $1
         OR EXISTS (SELECT 1 FROM event_stage_manager WHERE event_id = pe.id AND user_id = $1)
       )
     )
     ORDER BY er.published_at DESC NULLS LAST
     LIMIT 100`,
    [userId],
  );
  return res.rows.map(r => ({
    reportId: r.report_id,
    title: r.report_title,
    reportType: r.report_type,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    eventId: r.event_id,
    eventTitle: r.event_title,
    productionId: r.production_id,
    productionName: r.production_name,
    isRead: r.is_read,
  }));
}

export type WeeklyCallEvent = {
  eventId: string;
  eventTitle: string;
  eventLocation: string;
  productionId: string;
  productionName: string;
  calls: { callAt: string; notes: string }[];
  schedItems: { title: string; startTime: string | null }[];
};

export async function listWeeklyCallSchedule(
  userId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<WeeklyCallEvent[]> {
  type CallRow = {
    call_at: string; call_notes: string;
    event_id: string; event_title: string; event_location: string;
    production_id: string; production_name: string;
  };
  type SchedRow = { event_id: string; title: string; start_time: string | null };

  const [callsRes, schedRes] = await Promise.all([
    getPool().query<CallRow>(
      `SELECT ect.call_at, ect.notes AS call_notes,
              pe.id AS event_id, pe.title AS event_title,
              pe.location AS event_location,
              pe.production_id, p.name AS production_name
       FROM event_call_time ect
       JOIN production_event pe ON pe.id = ect.event_id
       JOIN production p ON p.id = pe.production_id
       WHERE ect.user_id = $1 AND ect.call_at >= $2 AND ect.call_at < $3
       ORDER BY ect.call_at`,
      [userId, weekStart.toISOString(), weekEnd.toISOString()],
    ),
    getPool().query<SchedRow>(
      `SELECT esi.event_id, esi.title, esi.start_time
       FROM event_schedule_item esi
       WHERE esi.event_id IN (
         SELECT DISTINCT event_id FROM event_call_time
         WHERE user_id = $1 AND call_at >= $2 AND call_at < $3
       )
       ORDER BY esi.event_id, esi.order_index`,
      [userId, weekStart.toISOString(), weekEnd.toISOString()],
    ),
  ]);

  const byEvent = new Map<string, WeeklyCallEvent>();
  for (const r of callsRes.rows) {
    if (!byEvent.has(r.event_id)) {
      byEvent.set(r.event_id, {
        eventId: r.event_id, eventTitle: r.event_title,
        eventLocation: r.event_location, productionId: r.production_id,
        productionName: r.production_name, calls: [], schedItems: [],
      });
    }
    byEvent.get(r.event_id)!.calls.push({ callAt: r.call_at, notes: r.call_notes });
  }
  for (const r of schedRes.rows) {
    byEvent.get(r.event_id)?.schedItems.push({ title: r.title, startTime: r.start_time });
  }

  return [...byEvent.values()];
}

// ─── Self-follow ──────────────────────────────────────────────────────────────

/** Add self as follower. If already a participant (any role), leaves the record unchanged. */
export async function selfFollowEvent(
  eventId: string, userId: string, name: string,
): Promise<void> {
  const id = `ef${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await getPool().query(
    `INSERT INTO event_participant (id, event_id, user_id, name, role)
     VALUES ($1, $2, $3, $4, 'follower')
     ON CONFLICT (event_id, user_id) DO NOTHING`,
    [id, eventId, userId, name]
  );
}

/** Remove self as follower. Only deletes if role='follower'; leaves participants untouched. */
export async function selfUnfollowEvent(eventId: string, userId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM event_participant
     WHERE event_id = $1 AND user_id = $2 AND role = 'follower'`,
    [eventId, userId]
  );
}

/** Returns the current user's participant role in an event, or null if not present. */
export async function getSelfParticipantRole(
  eventId: string, userId: string,
): Promise<"participant" | "follower" | null> {
  const res = await getPool().query<{ role: string }>(
    "SELECT role FROM event_participant WHERE event_id = $1 AND user_id = $2",
    [eventId, userId]
  );
  return (res.rows[0]?.role as "participant" | "follower") ?? null;
}

/** All call times for a specific user in a specific event. */
export async function listUserCallTimes(eventId: string, userId: string): Promise<EventCallTime[]> {
  const res = await getPool().query<CallTimeRow>(
    `SELECT id, event_id, user_id, name, department_id, call_at, schedule_item_id, notes
     FROM event_call_time WHERE event_id = $1 AND user_id = $2 ORDER BY call_at`,
    [eventId, userId]
  );
  return res.rows.map(rowToCallTime);
}

/** True if the user is an assignee of at least one tech req in the event. */
export async function isUserEventTechAssignee(eventId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_tech_assignee eta
       JOIN event_tech_req etr ON etr.id = eta.req_id
       WHERE etr.event_id = $1 AND eta.user_id = $2
     ) AS exists`,
    [eventId, userId]
  );
  return res.rows[0].exists;
}

/** True if the user is an assignee of a specific tech req. */
export async function isUserReqAssignee(reqId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_tech_assignee WHERE req_id = $1 AND user_id = $2
     ) AS exists`,
    [reqId, userId]
  );
  return res.rows[0].exists;
}

/** True if the user is a member of a specific event department. */
export async function isUserDeptMember(deptId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM production_dept_member
       WHERE dept_id = $1 AND user_id = $2
     ) AS exists`,
    [deptId, userId]
  );
  return res.rows[0].exists;
}

/** True if the user is a POC of a specific department. */
export async function isUserDeptPoc(deptId: string, userId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM production_dept_member
       WHERE dept_id = $1 AND user_id = $2 AND is_poc = true
     ) AS exists`,
    [deptId, userId]
  );
  return res.rows[0].exists;
}

export type MyTechReqFullEntry = {
  id: string;
  title: string;
  description: string;
  status: string;
  departmentId: string | null;
  departmentName: string | null;
  eventId: string;
  eventTitle: string;
  productionId: string;
  productionName: string;
  assignees: { userId: string; name: string }[];
  deptPeople: { userId: string; name: string }[];
  amPoc: boolean;
};

/** All tech reqs relevant to the user as POC or assignee, with full details for the personal page. */
export async function listMyTechReqsFull(userId: string): Promise<MyTechReqFullEntry[]> {
  const res = await getPool().query<{
    id: string; title: string; description: string; status: string;
    department_id: string | null; department_name: string | null;
    event_id: string; event_title: string;
    production_id: string; production_name: string;
    am_poc: boolean;
    assignees_json: { userId: string; name: string }[] | null;
    dept_people_json: { userId: string; name: string }[] | null;
  }>(
    `SELECT
       etr.id, etr.title, etr.description, etr.status, etr.department_id,
       ed.name AS department_name,
       pe.id AS event_id, pe.title AS event_title,
       pe.production_id, p.name AS production_name,
       (edm_poc.user_id IS NOT NULL) AS am_poc,
       (
         SELECT json_agg(json_build_object('userId', eta2.user_id, 'name', eta2.name)
                ORDER BY eta2.name)
         FROM event_tech_assignee eta2
         WHERE eta2.req_id = etr.id
       ) AS assignees_json,
       (
         SELECT json_agg(json_build_object('userId', edm2.user_id, 'name', COALESCE(up3.name, ''))
                ORDER BY up3.name)
         FROM production_dept_member edm2
         LEFT JOIN user_profile up3 ON up3.user_id = edm2.user_id
         WHERE edm2.dept_id = etr.department_id
       ) AS dept_people_json
     FROM event_tech_req etr
     JOIN production_event pe ON pe.id = etr.event_id
     JOIN production p ON p.id = pe.production_id
     LEFT JOIN production_dept ed ON ed.id = etr.department_id
     LEFT JOIN production_dept_member edm_poc
       ON edm_poc.dept_id = etr.department_id
       AND edm_poc.user_id = $1 AND edm_poc.is_poc = true
     LEFT JOIN event_tech_assignee eta
       ON eta.req_id = etr.id AND eta.user_id = $1
     WHERE pe.status != 'cancelled'
       AND (
         (etr.status = 'awaiting' AND edm_poc.user_id IS NOT NULL)
         OR (etr.status != 'awaiting' AND (eta.user_id IS NOT NULL OR edm_poc.user_id IS NOT NULL))
       )
     ORDER BY pe.start_time NULLS LAST, etr.created_at`,
    [userId]
  );
  return res.rows.map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    departmentId: r.department_id,
    departmentName: r.department_name,
    eventId: r.event_id,
    eventTitle: r.event_title,
    productionId: r.production_id,
    productionName: r.production_name,
    amPoc: r.am_poc,
    assignees: r.assignees_json ?? [],
    deptPeople: r.dept_people_json ?? [],
  }));
}

export type ProductionTechReqEntry = {
  id: string;
  title: string;
  description: string;
  status: string;
  departmentId: string | null;
  departmentName: string | null;
  eventId: string;
  eventTitle: string;
  eventStartTime: string | null;
  assignees: { userId: string; name: string }[];
};

/** 每个 event 的关联任务数（事件列表关联徽章用）。 */
export async function listEventTaskCounts(productionId: string): Promise<Record<string, number>> {
  const res = await getPool().query<{ event_id: string; count: string }>(
    `SELECT etr.event_id, COUNT(*) AS count
     FROM event_tech_req etr
     JOIN production_event pe ON pe.id = etr.event_id
     WHERE pe.production_id = $1
     GROUP BY etr.event_id`,
    [productionId],
  );
  return Object.fromEntries(res.rows.map(r => [r.event_id, Number(r.count)]));
}

export async function listProductionTechReqs(productionId: string): Promise<ProductionTechReqEntry[]> {
  const res = await getPool().query<{
    id: string; title: string; description: string; status: string;
    department_id: string | null; department_name: string | null;
    event_id: string; event_title: string; event_start_time: string | null;
    assignees_json: { userId: string; name: string }[] | null;
  }>(
    `SELECT
       etr.id, etr.title, etr.description, etr.status, etr.department_id,
       ed.name AS department_name,
       pe.id AS event_id, pe.title AS event_title, pe.start_time AS event_start_time,
       (
         SELECT json_agg(json_build_object('userId', eta.user_id, 'name', eta.name) ORDER BY eta.name)
         FROM event_tech_assignee eta WHERE eta.req_id = etr.id
       ) AS assignees_json
     FROM event_tech_req etr
     JOIN production_event pe ON pe.id = etr.event_id
     LEFT JOIN production_dept ed ON ed.id = etr.department_id
     WHERE pe.production_id = $1 AND pe.status != 'cancelled'
     ORDER BY pe.start_time NULLS LAST, etr.created_at`,
    [productionId]
  );
  return res.rows.map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    departmentId: r.department_id,
    departmentName: r.department_name,
    eventId: r.event_id,
    eventTitle: r.event_title,
    eventStartTime: r.event_start_time,
    assignees: r.assignees_json ?? [],
  }));
}

export type ProductionReportEntry = EventReport & {
  eventTitle: string;
  eventStartTime: string | null;
  eventStatus: "draft" | "published" | "completed" | "cancelled";
  isMentioned: boolean;
  isFollower: boolean;
  isParticipant: boolean;
};

/** All reports for a production visible to this user, with relationship flags.
 *  includeDrafts should only be true for users with isReportViewer permission. */
export async function listProductionReports(
  productionId: string,
  userId: string,
  includeDrafts: boolean,
): Promise<ProductionReportEntry[]> {
  const res = await getPool().query<ReportRow & {
    event_title: string; event_start_time: string | null; event_status: string;
    is_mentioned: boolean; is_follower: boolean; is_participant: boolean;
  }>(
    `SELECT er.id, er.event_id, er.report_type, w.title, w.body, w.created_by,
            er.created_at, er.updated_at, er.published_at, w.mentions,
            pe.title AS event_title, pe.start_time AS event_start_time, pe.status AS event_status,
            (w.mentions @> jsonb_build_array(jsonb_build_object('userId', $2::text))) AS is_mentioned,
            EXISTS (
              SELECT 1 FROM event_participant ep
              WHERE ep.event_id = pe.id AND ep.user_id = $2::uuid AND ep.role = 'follower'
            ) AS is_follower,
            EXISTS (
              SELECT 1 FROM event_participant ep
              WHERE ep.event_id = pe.id AND ep.user_id = $2::uuid AND ep.role = 'participant'
            ) AS is_participant
     FROM event_report er
     JOIN wiki w ON w.id = er.wiki_id
     JOIN production_event pe ON pe.id = er.event_id
     WHERE pe.production_id = $1
       AND ($3 OR er.published_at IS NOT NULL
            -- draft 可见：publication@view（本报告）或 event reports@view（本 event；'*' 已由 $3 覆盖）
            OR EXISTS (
              SELECT 1 FROM production_member_grant rg
              WHERE rg.user_id = $2::uuid AND rg.production_id = $1
                AND NOT rg.is_revoked
                AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
                AND ((rg.resource_type = 'report' AND rg.resource_id = er.id
                      AND rg.resource_sub = 'publication' AND rg.permission_level = 'view')
                  OR (rg.resource_type = 'event' AND rg.resource_id = er.event_id
                      AND rg.resource_sub = 'reports' AND rg.permission_level = 'view'))
            )
            -- 部门参与者可见 draft（发布前写 note 的业务规则，与 participantDeptIds 同谓词）
            OR EXISTS (
              SELECT 1 FROM event_participant ep_dept
              WHERE ep_dept.event_id = pe.id AND ep_dept.user_id = $2::uuid
                AND ep_dept.department_id IS NOT NULL
            ))
     ORDER BY COALESCE(er.published_at, er.updated_at) DESC`,
    [productionId, userId, includeDrafts]
  );
  return res.rows.map(r => ({
    ...rowToReport(r),
    eventTitle: r.event_title,
    eventStartTime: r.event_start_time,
    eventStatus: r.event_status as ProductionReportEntry["eventStatus"],
    isMentioned: r.is_mentioned,
    isFollower: r.is_follower,
    isParticipant: r.is_participant,
  }));
}

/** Batch-load the current user's participant role across all events in a production. */
export async function listUserEventParticipations(
  userId: string, productionId: string,
): Promise<{ eventId: string; role: "participant" | "follower" }[]> {
  const res = await getPool().query<{ event_id: string; role: string }>(
    `SELECT ep.event_id, ep.role
     FROM event_participant ep
     JOIN production_event pe ON pe.id = ep.event_id
     WHERE ep.user_id = $1 AND pe.production_id = $2`,
    [userId, productionId]
  );
  return res.rows.map(r => ({
    eventId: r.event_id,
    role: r.role as "participant" | "follower",
  }));
}

// ─── Dashboard queries ────────────────────────────────────────────────────────

export type MyCallTimeEntry = {
  id: string;
  callAt: string;
  notes: string;
  eventId: string;
  eventTitle: string;
  eventLocation: string;
  productionId: string;
  productionName: string;
};

export type MyPendingTechReqEntry = {
  id: string;
  title: string;
  status: string;
  eventId: string;
  eventTitle: string;
  productionId: string;
  productionName: string;
};

export type MyPocAwaitingReqEntry = {
  id: string;
  eventId: string;
  eventTitle: string;
  productionId: string;
  departmentName: string | null;
};

export async function listMyPocAwaitingReqs(userId: string, productionId?: string): Promise<MyPocAwaitingReqEntry[]> {
  const params: unknown[] = [userId];
  const prodFilter = productionId ? `AND pe.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{
    id: string; event_id: string; event_title: string; production_id: string; department_name: string | null;
  }>(
    `SELECT etr.id, pe.id AS event_id, pe.title AS event_title, pe.production_id, ed.name AS department_name
     FROM event_tech_req etr
     JOIN production_event pe ON pe.id = etr.event_id
     LEFT JOIN production_dept ed ON ed.id = etr.department_id
     JOIN production_dept_member edm_poc
       ON edm_poc.dept_id = etr.department_id
       AND edm_poc.user_id = $1 AND edm_poc.is_poc = true
     WHERE etr.status = 'awaiting'
       AND pe.status != 'cancelled'
       ${prodFilter}
     ORDER BY pe.start_time NULLS LAST, etr.created_at`,
    params
  );
  return res.rows.map(r => ({
    id: r.id,
    eventId: r.event_id,
    eventTitle: r.event_title,
    productionId: r.production_id,
    departmentName: r.department_name,
  }));
}

function currentCSTWeekRange(): { weekStart: Date; weekEnd: Date } {
  const now = new Date(Date.now() + 8 * 3_600_000); // shift to CST
  const dow = now.getUTCDay();
  const afterSundayNoon = dow === 0 && (now.getUTCHours() > 12 || (now.getUTCHours() === 12 && now.getUTCMinutes() >= 0));
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const weekOffset = afterSundayNoon ? 7 : 0;
  const mondayCSTDate = now.getUTCDate() - daysFromMonday + weekOffset;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), mondayCSTDate) - 8 * 3_600_000);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);
  return { weekStart, weekEnd };
}

export async function listMyUpcomingCallTimes(userId: string, productionId?: string): Promise<MyCallTimeEntry[]> {
  const { weekStart, weekEnd } = currentCSTWeekRange();
  const params: unknown[] = [userId, weekStart.toISOString(), weekEnd.toISOString()];
  const prodFilter = productionId ? `AND pe.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{
    id: string; call_at: Date; notes: string;
    event_id: string; event_title: string; event_location: string;
    production_id: string; production_name: string;
  }>(
    `SELECT ect.id, ect.call_at, ect.notes,
            pe.id AS event_id, pe.title AS event_title, pe.location AS event_location,
            pe.production_id, p.name AS production_name
     FROM event_call_time ect
     JOIN production_event pe ON pe.id = ect.event_id
     JOIN production p ON p.id = pe.production_id
     WHERE ect.user_id = $1
       AND pe.status = 'published'
       AND ect.call_at >= $2
       AND ect.call_at < $3
       ${prodFilter}
     ORDER BY ect.call_at`,
    params
  );
  return res.rows.map(r => ({
    id: r.id,
    callAt: r.call_at.toISOString(),
    notes: r.notes,
    eventId: r.event_id,
    eventTitle: r.event_title,
    eventLocation: r.event_location,
    productionId: r.production_id,
    productionName: r.production_name,
  }));
}

export type MyFollowedEventEntry = {
  eventId: string;
  eventTitle: string;
  eventType: string;
  eventLocation: string;
  startTime: string | null;
  productionId: string;
  productionName: string;
};

export async function listMyFollowedUpcomingEvents(userId: string): Promise<MyFollowedEventEntry[]> {
  const res = await getPool().query<{
    event_id: string; event_title: string; event_type: string; event_location: string;
    start_time: Date | null; production_id: string; production_name: string;
  }>(
    `SELECT pe.id AS event_id, pe.title AS event_title, pe.event_type,
            pe.location AS event_location, pe.start_time,
            pe.production_id, p.name AS production_name
     FROM event_participant ep
     JOIN production_event pe ON pe.id = ep.event_id
     JOIN production p ON p.id = pe.production_id
     WHERE ep.user_id = $1 AND ep.role = 'follower'
       AND pe.status = 'published'
       AND (pe.start_time IS NULL OR pe.start_time >= now())
     ORDER BY pe.start_time NULLS LAST`,
    [userId]
  );
  return res.rows.map(r => ({
    eventId: r.event_id,
    eventTitle: r.event_title,
    eventType: r.event_type,
    eventLocation: r.event_location,
    startTime: r.start_time?.toISOString() ?? null,
    productionId: r.production_id,
    productionName: r.production_name,
  }));
}

export async function listMyPendingTechReqs(userId: string, productionId?: string): Promise<MyPendingTechReqEntry[]> {
  const params: unknown[] = [userId];
  const prodFilter = productionId ? `AND pe.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{
    id: string; title: string; status: string;
    event_id: string; event_title: string;
    production_id: string; production_name: string;
  }>(
    `SELECT etr.id, etr.title, etr.status,
            pe.id AS event_id, pe.title AS event_title,
            pe.production_id, p.name AS production_name
     FROM event_tech_req etr
     JOIN event_tech_assignee eta ON eta.req_id = etr.id AND eta.user_id = $1
     JOIN production_event pe ON pe.id = etr.event_id
     JOIN production p ON p.id = pe.production_id
     WHERE etr.status NOT IN ('done', 'awaiting')
       ${prodFilter}
     ORDER BY etr.created_at`,
    params
  );
  return res.rows.map(r => ({
    id: r.id,
    title: r.title,
    status: r.status,
    eventId: r.event_id,
    eventTitle: r.event_title,
    productionId: r.production_id,
    productionName: r.production_name,
  }));
}

// ─── Report Replies ───────────────────────────────────────────────────────────

export type ReportReply = {
  id: string;
  reportId: string;
  parentType: "report" | "note" | "reply";
  parentId: string;
  userId: string;
  authorName: string;
  content: string;
  mentions: Mention[];
  createdAt: string;
};

type ReplyRow = {
  id: string; report_id: string; parent_type: string; parent_id: string;
  user_id: string; author_name: string; content: string; mentions: Mention[]; created_at: Date;
};

function rowToReply(r: ReplyRow): ReportReply {
  return {
    id: r.id, reportId: r.report_id,
    parentType: r.parent_type as ReportReply["parentType"],
    parentId: r.parent_id, userId: r.user_id, authorName: r.author_name,
    content: r.content, mentions: r.mentions ?? [],
    createdAt: r.created_at.toISOString(),
  };
}

export async function listReportReplies(reportId: string): Promise<ReportReply[]> {
  // 拆分模型：评论存 wiki_comment（挂内容实体）；parentType/parentId 由关系投影反推
  const res = await getPool().query<ReplyRow>(
    `SELECT wc.id, $1 AS report_id,
            CASE WHEN wc.parent_comment_id IS NOT NULL THEN 'reply'
                 WHEN n.id IS NOT NULL THEN 'note' ELSE 'report' END AS parent_type,
            COALESCE(wc.parent_comment_id::text, n.id, $1) AS parent_id,
            wc.user_id, wc.author_name, wc.content, wc.mentions, wc.created_at
     FROM wiki_comment wc
     LEFT JOIN event_report er ON er.wiki_id = wc.wiki_id AND er.id = $1
     LEFT JOIN event_report_note n ON n.wiki_id = wc.wiki_id AND n.report_id = $1
     WHERE er.id IS NOT NULL OR n.id IS NOT NULL
     ORDER BY wc.created_at ASC`,
    [reportId]
  );
  return res.rows.map(rowToReply);
}

export async function createReportReply(params: {
  id: string; reportId: string; parentType: ReportReply["parentType"];
  parentId: string; userId: string; authorName: string; content: string; mentions?: Mention[];
}): Promise<ReportReply> {
  // 拆分模型：目标 wiki 依 parentType 解析；id 由 wiki_comment 生成（UUID），
  // 忽略调用方 params.id（API 消费方使用返回值 id）
  const pool = getPool();
  let wikiId: string | null = null;
  let parentCommentId: string | null = null;
  if (params.parentType === "note") {
    const r = await pool.query<{ wiki_id: string }>(
      "SELECT wiki_id FROM event_report_note WHERE id = $1 AND report_id = $2",
      [params.parentId, params.reportId]);
    wikiId = r.rows[0]?.wiki_id ?? null;
  } else if (params.parentType === "reply") {
    const r = await pool.query<{ wiki_id: string }>(
      "SELECT wiki_id FROM wiki_comment WHERE id = $1::uuid", [params.parentId]);
    wikiId = r.rows[0]?.wiki_id ?? null;
    parentCommentId = params.parentId;
  } else {
    const r = await pool.query<{ wiki_id: string }>(
      "SELECT wiki_id FROM event_report WHERE id = $1", [params.reportId]);
    wikiId = r.rows[0]?.wiki_id ?? null;
  }
  if (!wikiId) throw new Error(`reply target not found: ${params.parentType}/${params.parentId}`);
  const res = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO wiki_comment (wiki_id, parent_comment_id, user_id, author_name, content, mentions)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [wikiId, parentCommentId, params.userId, params.authorName, params.content,
     JSON.stringify(params.mentions ?? [])]
  );
  return {
    id: res.rows[0].id, reportId: params.reportId,
    parentType: params.parentType, parentId: params.parentId,
    userId: params.userId, authorName: params.authorName,
    content: params.content, mentions: params.mentions ?? [],
    createdAt: res.rows[0].created_at.toISOString(),
  };
}

export async function getReportReply(id: string, reportId: string): Promise<ReportReply | null> {
  const res = await getPool().query<ReplyRow>(
    `SELECT wc.id, $2 AS report_id,
            CASE WHEN wc.parent_comment_id IS NOT NULL THEN 'reply'
                 WHEN n.id IS NOT NULL THEN 'note' ELSE 'report' END AS parent_type,
            COALESCE(wc.parent_comment_id::text, n.id, $2) AS parent_id,
            wc.user_id, wc.author_name, wc.content, wc.mentions, wc.created_at
     FROM wiki_comment wc
     LEFT JOIN event_report er ON er.wiki_id = wc.wiki_id AND er.id = $2
     LEFT JOIN event_report_note n ON n.wiki_id = wc.wiki_id AND n.report_id = $2
     WHERE wc.id = $1::uuid AND (er.id IS NOT NULL OR n.id IS NOT NULL)`,
    [id, reportId]
  );
  return res.rows[0] ? rowToReply(res.rows[0]) : null;
}

export async function deleteReportReply(id: string, reportId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM wiki_comment wc
     USING wiki w
     WHERE wc.id = $1::uuid AND wc.wiki_id = w.id
       AND (EXISTS (SELECT 1 FROM event_report er
     JOIN wiki w ON w.id = er.wiki_id WHERE er.wiki_id = w.id AND er.id = $2)
         OR EXISTS (SELECT 1 FROM event_report_note n WHERE n.wiki_id = w.id AND n.report_id = $2))`,
    [id, reportId]
  );
}

// ─── Group chat ID management ─────────────────────────────────────────────────

export async function clearEventChatId(eventId: string): Promise<void> {
  await getPool().query("UPDATE production_event SET chat_id = NULL WHERE id = $1", [eventId]);
}

export async function clearTechReqChatId(reqId: string): Promise<void> {
  await getPool().query("UPDATE event_tech_req SET chat_id = NULL WHERE id = $1", [reqId]);
}

export async function setDepartmentChatId(deptId: string, chatId: string): Promise<void> {
  await getPool().query(
    "UPDATE production_dept SET chat_id = $1 WHERE id = $2",
    [chatId, deptId]
  );
}

export async function setEventChatId(eventId: string, chatId: string): Promise<void> {
  await getPool().query(
    "UPDATE production_event SET chat_id = $1 WHERE id = $2",
    [chatId, eventId]
  );
}

export async function setTechReqChatId(reqId: string, chatId: string): Promise<void> {
  await getPool().query(
    "UPDATE event_tech_req SET chat_id = $1 WHERE id = $2",
    [chatId, reqId]
  );
}

/** Returns all dept chat_ids for a production (used to filter out dept groups when binding). */
export async function getProductionDeptChatIds(productionId: string): Promise<Set<string>> {
  const res = await getPool().query<{ chat_id: string }>(
    "SELECT chat_id FROM production_dept WHERE production_id = $1 AND chat_id IS NOT NULL",
    [productionId]
  );
  return new Set(res.rows.map(r => r.chat_id));
}

/** Returns current dept member entries — used to compute diff for Feishu sync. */
export async function getDepartmentCurrentEntries(
  deptId: string
): Promise<{ userId: string; isMember: boolean; isPoc: boolean }[]> {
  const res = await getPool().query<{ user_id: string; is_poc: boolean }>(
    "SELECT user_id, is_poc FROM production_dept_member WHERE dept_id = $1",
    [deptId]
  );
  return res.rows.map(r => ({ userId: r.user_id, isMember: true, isPoc: r.is_poc }));
}

/** Returns all Feishu open_ids for an event's group chat (participants + call-time people). */
export async function getEventChatTargets(eventId: string): Promise<string[]> {
  const res = await getPool().query<{ open_id: string }>(
    `SELECT DISTINCT fu.open_id
     FROM event_participant ep
     JOIN feishu_user fu ON fu.user_id = ep.user_id
     WHERE ep.event_id = $1
     UNION
     SELECT fu.open_id
     FROM event_call_time ect
     JOIN feishu_user fu ON fu.user_id = ect.user_id
     WHERE ect.event_id = $1`,
    [eventId]
  );
  return res.rows.map(r => r.open_id);
}

/** Returns all Feishu open_ids for a req's group chat (assignees + dept POCs). */
export async function getReqChatTargets(reqId: string): Promise<string[]> {
  const res = await getPool().query<{ open_id: string }>(
    `SELECT fu.open_id
     FROM event_tech_assignee eta
     JOIN feishu_user fu ON fu.user_id = eta.user_id
     WHERE eta.req_id = $1
     UNION
     SELECT fu.open_id
     FROM event_tech_req etr
     JOIN production_dept_member edm ON edm.dept_id = etr.department_id AND edm.is_poc = true
     JOIN feishu_user fu ON fu.user_id = edm.user_id
     WHERE etr.id = $1`,
    [reqId]
  );
  return res.rows.map(r => r.open_id);
}

/** Returns all tech reqs in a dept that have a chat_id (for POC-add sync). */
export async function getDeptReqsWithChat(
  deptId: string
): Promise<{ id: string; chatId: string }[]> {
  const res = await getPool().query<{ id: string; chat_id: string }>(
    "SELECT id, chat_id FROM event_tech_req WHERE department_id = $1 AND chat_id IS NOT NULL",
    [deptId]
  );
  return res.rows.map(r => ({ id: r.id, chatId: r.chat_id }));
}

/**
 * Reports badge count:
 *   Condition 1 — published AND unread AND
 *     (user is participant OR has call_time OR is mentioned in report)
 *   Condition 2 — draft AND event completed AND
 *     (user created the event OR is stage manager)
 */
export async function countUnreadReportsForUser(userId: string, productionId?: string): Promise<number> {
  const params: unknown[] = [userId];
  const prodFilter = productionId ? `AND pe.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(DISTINCT er.id) AS count
     FROM event_report er
     JOIN wiki w ON w.id = er.wiki_id
     JOIN production_event pe ON pe.id = er.event_id
     WHERE (
       er.published_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM event_report_read err
         WHERE err.report_id = er.id AND err.user_id = $1
       )
       AND (
         EXISTS (SELECT 1 FROM event_participant WHERE event_id = pe.id AND user_id = $1)
         OR EXISTS (SELECT 1 FROM event_call_time WHERE event_id = pe.id AND user_id = $1)
         OR w.mentions @> jsonb_build_array(jsonb_build_object('userId', $1::text))
       )
       ${prodFilter}
     ) OR (
       er.published_at IS NULL
       AND pe.status = 'completed'
       AND (
         pe.created_by = $1
         OR EXISTS (SELECT 1 FROM event_stage_manager WHERE event_id = pe.id AND user_id = $1)
       )
       ${prodFilter}
     )`,
    params,
  );
  return parseInt(res.rows[0].count, 10);
}

/**
 * Tasks that still need the user's attention:
 *   (POC of dept OR assignee) AND status IN ('pending', 'in_progress')
 *   OR POC of dept AND status = 'awaiting'
 */
export async function countPendingTasksForUser(userId: string, productionId?: string): Promise<number> {
  const params: unknown[] = [userId];
  const prodFilter = productionId ? `AND pe.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(DISTINCT etr.id) AS count
     FROM event_tech_req etr
     JOIN production_event pe ON pe.id = etr.event_id
     LEFT JOIN production_dept_member edm_poc
       ON edm_poc.dept_id = etr.department_id
      AND edm_poc.user_id = $1
      AND edm_poc.is_poc = true
     LEFT JOIN event_tech_assignee eta
       ON eta.req_id = etr.id
      AND eta.user_id = $1
     WHERE (
       (edm_poc.user_id IS NOT NULL OR eta.user_id IS NOT NULL)
       AND etr.status IN ('pending', 'in_progress')
       ${prodFilter}
     ) OR (
       edm_poc.user_id IS NOT NULL
       AND etr.status = 'awaiting'
       ${prodFilter}
     )`,
    params,
  );
  return parseInt(res.rows[0].count, 10);
}

// ─── Call schedule types (shared between notify and platform card builders) ───

export type WeeklyCallEntry = {
  callAt: string;
  eventId: string;
  eventTitle: string;
  eventDescription: string;
  eventLocation: string;
  callNotes: string;
  productionId: string;
  scheduleItems: { title: string; startTime: string | null }[];
  myTechReqs: { title: string }[];
};

export type DailyCallScheduleItem = {
  title: string;
  startTime: string | null;
  participants: string[];
};
