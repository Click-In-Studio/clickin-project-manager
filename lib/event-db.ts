import { getPool } from "./pg";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventDepartment = {
  id: string;
  productionId: string;
  name: string;
  /** 'dept' = 部门 (can be mentioned in report notes); 'group' = 用户组 (call selection only) */
  kind: "dept" | "group";
  displayOrder: number;
  memberOpenIds: string[];
  pocOpenIds: string[];
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
  stageManagers: { openId: string; name: string }[];
  chatId: string | null;
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

export type ScheduleItemParticipant = { openId: string; name: string };

export type EventScheduleItemWithParticipants = EventScheduleItem & {
  participants: ScheduleItemParticipant[];
  departmentIds: string[];
};

export type EventParticipant = {
  id: string;
  eventId: string;
  openId: string;
  name: string;
  departmentId: string | null;
  role: "participant" | "follower";
};

export type EventCallTime = {
  id: string;
  eventId: string;
  openId: string;
  name: string;
  departmentId: string | null;
  callAt: string;
  scheduleItemId: string | null;
  notes: string;
};

export type EventTechReqAssignee = { openId: string; name: string };

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
};

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
};

export type EventReportNote = {
  id: string;
  reportId: string;
  departmentId: string;
  content: string;
  authorOpenId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

export type UnreadReportEntry = {
  reportId: string;
  reportTitle: string;
  publishedAt: string;
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
  created_by: string; created_at: Date; updated_at: Date;
};

type ScheduleItemRow = {
  id: string; event_id: string; title: string; item_type: string;
  start_time: Date | null; end_time: Date | null; location: string;
  order_index: number; target_scene_id: string | null;
  target_block_id: string | null; notes: string;
};

type ParticipantRow = {
  id: string; event_id: string; open_id: string; name: string;
  department_id: string | null; role: string;
};

type CallTimeRow = {
  id: string; event_id: string; open_id: string; name: string;
  department_id: string | null; call_at: Date;
  schedule_item_id: string | null; notes: string;
};

type TechReqRow = {
  id: string; event_id: string;
  title: string; description: string; preset_minutes: number | null;
  department_id: string | null; status: string; chat_id: string | null; created_at: Date;
};

type TechAssigneeRow = { req_id: string; open_id: string; name: string };

type ReportRow = {
  id: string; event_id: string; report_type: string; title: string;
  body: string; created_by: string; created_at: Date; updated_at: Date;
  published_at: Date | null;
};

type ReportNoteRow = {
  id: string; report_id: string; department_id: string; content: string;
  author_open_id: string; author_name: string;
  created_at: Date; updated_at: Date;
};

// ─── Row converters ───────────────────────────────────────────────────────────

function rowToDept(r: DeptRow, memberOpenIds: string[], pocOpenIds: string[]): EventDepartment {
  return {
    id: r.id, productionId: r.production_id, name: r.name,
    kind: r.kind as EventDepartment["kind"], displayOrder: r.display_order,
    memberOpenIds, pocOpenIds, chatId: r.chat_id ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

function rowToEvent(r: EventRow, stageManagers: { openId: string; name: string }[] = []): ProductionEvent {
  return {
    id: r.id, productionId: r.production_id, title: r.title,
    eventType: r.event_type, location: r.location,
    startTime: r.start_time?.toISOString() ?? null,
    endTime: r.end_time?.toISOString() ?? null,
    status: r.status as ProductionEvent["status"],
    description: r.description,
    stageManagers,
    chatId: r.chat_id ?? null,
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
    id: r.id, eventId: r.event_id, openId: r.open_id, name: r.name,
    departmentId: r.department_id, role: r.role as EventParticipant["role"],
  };
}

function rowToCallTime(r: CallTimeRow): EventCallTime {
  return {
    id: r.id, eventId: r.event_id, openId: r.open_id, name: r.name,
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
    createdAt: r.created_at.toISOString(),
  };
}

function rowToReport(r: ReportRow): EventReport {
  return {
    id: r.id, eventId: r.event_id, reportType: r.report_type,
    title: r.title, body: r.body, createdBy: r.created_by,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    publishedAt: r.published_at?.toISOString() ?? null,
  };
}

function rowToReportNote(r: ReportNoteRow): EventReportNote {
  return {
    id: r.id, reportId: r.report_id, departmentId: r.department_id,
    content: r.content, authorOpenId: r.author_open_id, authorName: r.author_name,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

// ─── Departments ──────────────────────────────────────────────────────────────

type MemberRow = { department_id: string; open_id: string; is_member: boolean; is_poc: boolean };

export async function listEventDepartments(productionId: string): Promise<EventDepartment[]> {
  const pool = getPool();
  const [deptRes, memberRes] = await Promise.all([
    pool.query<DeptRow>(
      `SELECT id, production_id, name, kind, display_order, chat_id, created_at
       FROM event_department WHERE production_id = $1 ORDER BY display_order, name`,
      [productionId]
    ),
    pool.query<MemberRow>(
      `SELECT edm.department_id, edm.open_id, edm.is_member, edm.is_poc
       FROM event_department_member edm
       JOIN event_department ed ON ed.id = edm.department_id
       WHERE ed.production_id = $1`,
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
      rows.filter(m => m.is_member).map(m => m.open_id),
      rows.filter(m => m.is_poc).map(m => m.open_id),
    );
  });
}

export async function getEventDepartment(id: string, productionId: string): Promise<EventDepartment | null> {
  const pool = getPool();
  const [deptRes, memberRes] = await Promise.all([
    pool.query<DeptRow>(
      `SELECT id, production_id, name, kind, display_order, chat_id, created_at
       FROM event_department WHERE id = $1 AND production_id = $2`,
      [id, productionId]
    ),
    pool.query<{ open_id: string; is_member: boolean; is_poc: boolean }>(
      "SELECT open_id, is_member, is_poc FROM event_department_member WHERE department_id = $1",
      [id]
    ),
  ]);
  if (!deptRes.rows[0]) return null;
  return rowToDept(
    deptRes.rows[0],
    memberRes.rows.filter(r => r.is_member).map(r => r.open_id),
    memberRes.rows.filter(r => r.is_poc).map(r => r.open_id),
  );
}

export async function createEventDepartment(data: {
  id: string; productionId: string; name: string;
  kind: "dept" | "group"; displayOrder: number;
}): Promise<EventDepartment> {
  const res = await getPool().query<DeptRow>(
    `INSERT INTO event_department (id, production_id, name, kind, display_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, production_id, name, kind, display_order, chat_id, created_at`,
    [data.id, data.productionId, data.name, data.kind, data.displayOrder]
  );
  return rowToDept(res.rows[0], [], []);
}

export async function updateEventDepartment(
  id: string, productionId: string,
  fields: { name?: string; kind?: "dept" | "group"; displayOrder?: number }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id, productionId];
  if (fields.name         !== undefined) sets.push(`name          = $${vals.push(fields.name)}`);
  if (fields.kind         !== undefined) sets.push(`kind          = $${vals.push(fields.kind)}`);
  if (fields.displayOrder !== undefined) sets.push(`display_order = $${vals.push(fields.displayOrder)}`);
  if (!sets.length) return;
  await getPool().query(
    `UPDATE event_department SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2`,
    vals
  );
}

export async function deleteEventDepartment(id: string, productionId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM event_department WHERE id = $1 AND production_id = $2",
    [id, productionId]
  );
}

/** Replace the full member/POC list for a department in one transaction.
 *  Entries with both isMember=false and isPoc=false are silently dropped.
 */
export async function setDepartmentMembers(
  deptId: string,
  members: { openId: string; isMember: boolean; isPoc: boolean }[],
): Promise<void> {
  const seen = new Set<string>();
  const unique = members.filter(m => {
    if (seen.has(m.openId)) return false;
    seen.add(m.openId);
    return m.isMember || m.isPoc;
  });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_department_member WHERE department_id = $1", [deptId]);
    for (const m of unique) {
      await client.query(
        "INSERT INTO event_department_member (department_id, open_id, is_member, is_poc) VALUES ($1,$2,$3,$4)",
        [deptId, m.openId, m.isMember, m.isPoc],
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

/** Replace the full participant list for an event in one transaction. */
export async function setEventParticipants(
  eventId: string,
  participants: { openId: string; name: string; departmentId: string | null; role: "participant" | "follower" }[],
): Promise<void> {
  const seen = new Set<string>();
  const unique = participants.filter(p => { if (seen.has(p.openId)) return false; seen.add(p.openId); return true; });
  let _s = 0;
  const pid = () => `ep${Date.now().toString(36)}${(++_s).toString(36)}`;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_participant WHERE event_id = $1", [eventId]);
    for (const p of unique) {
      await client.query(
        "INSERT INTO event_participant (id, event_id, open_id, name, department_id, role) VALUES ($1,$2,$3,$4,$5,$6)",
        [pid(), eventId, p.openId, p.name, p.departmentId, p.role],
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
              start_time, end_time, status, description, chat_id,
              created_by, created_at, updated_at
       FROM production_event WHERE production_id = $1 ORDER BY start_time NULLS LAST, created_at`,
      [productionId]
    ),
    pool.query<{ event_id: string; open_id: string; name: string }>(
      `SELECT esm.event_id, esm.open_id, esm.name
       FROM event_stage_manager esm
       JOIN production_event pe ON pe.id = esm.event_id
       WHERE pe.production_id = $1`,
      [productionId]
    ),
  ]);
  const smMap = new Map<string, { openId: string; name: string }[]>();
  for (const r of smRes.rows) {
    if (!smMap.has(r.event_id)) smMap.set(r.event_id, []);
    smMap.get(r.event_id)!.push({ openId: r.open_id, name: r.name });
  }
  const events = eventsRes.rows.map(r => rowToEvent(r, smMap.get(r.id) ?? []));
  return Promise.all(events.map(maybeAutoComplete));
}

export async function getProductionEvent(id: string, productionId: string): Promise<ProductionEvent | null> {
  const pool = getPool();
  const [eventsRes, smRes] = await Promise.all([
    pool.query<EventRow>(
      `SELECT id, production_id, title, event_type, location,
              start_time, end_time, status, description, chat_id,
              created_by, created_at, updated_at
       FROM production_event WHERE id = $1 AND production_id = $2`,
      [id, productionId]
    ),
    pool.query<{ open_id: string; name: string }>(
      "SELECT open_id, name FROM event_stage_manager WHERE event_id = $1",
      [id]
    ),
  ]);
  if (!eventsRes.rows[0]) return null;
  const event = rowToEvent(eventsRes.rows[0], smRes.rows.map(r => ({ openId: r.open_id, name: r.name })));
  return maybeAutoComplete(event);
}

export async function setEventStageManagers(
  eventId: string,
  managers: { openId: string; name: string }[],
): Promise<void> {
  const seen = new Set<string>();
  const unique = managers.filter(m => { if (seen.has(m.openId)) return false; seen.add(m.openId); return true; });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_stage_manager WHERE event_id = $1", [eventId]);
    for (const m of unique) {
      await client.query(
        "INSERT INTO event_stage_manager (event_id, open_id, name) VALUES ($1,$2,$3)",
        [eventId, m.openId, m.name],
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
  description: string; createdBy: string;
}): Promise<ProductionEvent> {
  const res = await getPool().query<EventRow>(
    `INSERT INTO production_event
       (id, production_id, title, event_type, location, start_time, end_time, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, production_id, title, event_type, location,
               start_time, end_time, status, description, chat_id,
               created_by, created_at, updated_at`,
    [data.id, data.productionId, data.title, data.eventType, data.location,
     data.startTime, data.endTime, data.description, data.createdBy]
  );
  return rowToEvent(res.rows[0]);
}

export async function updateProductionEvent(
  id: string, productionId: string,
  fields: {
    title?: string; eventType?: string; location?: string;
    startTime?: string | null; endTime?: string | null;
    status?: ProductionEvent["status"]; description?: string;
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
  if (!sets.length) return getProductionEvent(id, productionId);
  sets.push(`updated_at = now()`);
  const res = await getPool().query<EventRow>(
    `UPDATE production_event SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2
     RETURNING id, production_id, title, event_type, location,
               start_time, end_time, status, description, chat_id,
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
  const res = await getPool().query<{ open_id: string; name: string }>(
    "SELECT open_id, name FROM schedule_item_participant WHERE item_id = $1 ORDER BY name",
    [itemId]
  );
  return res.rows.map(r => ({ openId: r.open_id, name: r.name }));
}

export async function setScheduleItemParticipants(
  itemId: string,
  participants: ScheduleItemParticipant[],
): Promise<void> {
  const seen = new Set<string>();
  const unique = participants.filter(p => { if (seen.has(p.openId)) return false; seen.add(p.openId); return true; });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM schedule_item_participant WHERE item_id = $1", [itemId]);
    for (const p of unique) {
      await client.query(
        "INSERT INTO schedule_item_participant (item_id, open_id, name) VALUES ($1,$2,$3)",
        [itemId, p.openId, p.name],
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
    pool.query<{ item_id: string; open_id: string; name: string }>(
      `SELECT sip.item_id, sip.open_id, sip.name
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
    partMap.get(r.item_id)!.push({ openId: r.open_id, name: r.name });
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
export async function listEventPeople(eventId: string): Promise<{ openId: string; name: string }[]> {
  const res = await getPool().query<{ open_id: string; name: string }>(
    `SELECT DISTINCT p.open_id, p.name
     FROM schedule_item_participant p
     JOIN event_schedule_item esi ON esi.id = p.item_id
     WHERE esi.event_id = $1
     UNION
     SELECT a.open_id, a.name
     FROM event_tech_assignee a
     JOIN event_tech_req tr ON tr.id = a.req_id
     WHERE tr.event_id = $1 AND tr.status != 'awaiting'
     ORDER BY name`,
    [eventId]
  );
  return res.rows.map(r => ({ openId: r.open_id, name: r.name }));
}

// ─── Participants / Followers ─────────────────────────────────────────────────

export async function listEventParticipants(eventId: string): Promise<EventParticipant[]> {
  const res = await getPool().query<ParticipantRow>(
    `SELECT id, event_id, open_id, name, department_id, role
     FROM event_participant WHERE event_id = $1 ORDER BY role, name`,
    [eventId]
  );
  return res.rows.map(rowToParticipant);
}

export async function upsertEventParticipant(data: {
  id: string; eventId: string; openId: string; name: string;
  departmentId: string | null; role: "participant" | "follower";
}): Promise<EventParticipant> {
  const res = await getPool().query<ParticipantRow>(
    `INSERT INTO event_participant (id, event_id, open_id, name, department_id, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id, open_id) DO UPDATE
       SET name = EXCLUDED.name, department_id = EXCLUDED.department_id, role = EXCLUDED.role
     RETURNING id, event_id, open_id, name, department_id, role`,
    [data.id, data.eventId, data.openId, data.name, data.departmentId, data.role]
  );
  return rowToParticipant(res.rows[0]);
}

export async function removeEventParticipant(eventId: string, openId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM event_participant WHERE event_id = $1 AND open_id = $2",
    [eventId, openId]
  );
}

export async function isEventFollower(eventId: string, openId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_participant WHERE event_id = $1 AND open_id = $2
     ) AS exists`,
    [eventId, openId]
  );
  return res.rows[0].exists;
}

// Returns the department_ids this user is assigned to as a participant in an event.
export async function getParticipantDeptIds(eventId: string, openId: string): Promise<string[]> {
  const res = await getPool().query<{ department_id: string }>(
    `SELECT department_id FROM event_participant
     WHERE event_id = $1 AND open_id = $2 AND department_id IS NOT NULL`,
    [eventId, openId]
  );
  return res.rows.map(r => r.department_id);
}

// ─── Call Times ───────────────────────────────────────────────────────────────

export async function listEventCallTimes(eventId: string): Promise<EventCallTime[]> {
  const res = await getPool().query<CallTimeRow>(
    `SELECT id, event_id, open_id, name, department_id, call_at, schedule_item_id, notes
     FROM event_call_time WHERE event_id = $1 ORDER BY call_at, name`,
    [eventId]
  );
  return res.rows.map(rowToCallTime);
}

export async function createEventCallTime(data: {
  id: string; eventId: string; openId: string; name: string;
  departmentId: string | null; callAt: string;
  scheduleItemId: string | null; notes: string;
}): Promise<EventCallTime> {
  const res = await getPool().query<CallTimeRow>(
    `INSERT INTO event_call_time
       (id, event_id, open_id, name, department_id, call_at, schedule_item_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, event_id, open_id, name, department_id, call_at, schedule_item_id, notes`,
    [data.id, data.eventId, data.openId, data.name, data.departmentId,
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
     RETURNING id, event_id, open_id, name, department_id, call_at, schedule_item_id, notes`,
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
              preset_minutes, department_id, status, chat_id, created_at
       FROM event_tech_req WHERE event_id = $1 ORDER BY created_at`,
      [eventId]
    ),
    pool.query<TechAssigneeRow>(
      `SELECT eta.req_id, eta.open_id, eta.name
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
    assigneeMap.get(r.req_id)!.push({ openId: r.open_id, name: r.name });
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
              preset_minutes, department_id, status, chat_id, created_at
       FROM event_tech_req WHERE id = $1 AND event_id = $2`,
      [id, eventId]
    ),
    pool.query<TechAssigneeRow>(
      "SELECT req_id, open_id, name FROM event_tech_assignee WHERE req_id = $1",
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
    assigneeRes.rows.map(r => ({ openId: r.open_id, name: r.name })),
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
}): Promise<EventTechReq> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<TechReqRow>(
      `INSERT INTO event_tech_req
         (id, event_id, title, description, preset_minutes, department_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, event_id, title, description,
                 preset_minutes, department_id, status, chat_id, created_at`,
      [data.id, data.eventId, data.title, data.description, data.presetMinutes, data.departmentId]
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
        "INSERT INTO event_tech_assignee (req_id, open_id, name) VALUES ($1,$2,$3)",
        [data.id, a.openId, a.name]
      );
    }
    await client.query("COMMIT");
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
               preset_minutes, department_id, status, chat_id, created_at`,
    vals
  );
  if (!res.rows[0]) return null;
  const [assigneeRes, itemRes] = await Promise.all([
    getPool().query<TechAssigneeRow>(
      "SELECT req_id, open_id, name FROM event_tech_assignee WHERE req_id = $1", [id]
    ),
    getPool().query<{ item_id: string }>(
      "SELECT item_id FROM event_tech_req_item WHERE req_id = $1", [id]
    ),
  ]);
  return rowToTechReq(
    res.rows[0],
    assigneeRes.rows.map(r => ({ openId: r.open_id, name: r.name })),
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
        `INSERT INTO event_tech_req (id, event_id, title, description, department_id, status)
         VALUES ($1, $2, '', '', $3, 'awaiting')`,
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

  return result;
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
        "INSERT INTO event_tech_assignee (req_id, open_id, name) VALUES ($1,$2,$3)",
        [reqId, a.openId, a.name]
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
    `SELECT id, event_id, report_type, title, body, created_by,
            created_at, updated_at, published_at
     FROM event_report WHERE event_id = $1 ORDER BY created_at`,
    [eventId]
  );
  return res.rows.map(rowToReport);
}

export async function getEventReport(id: string, eventId: string): Promise<EventReport | null> {
  const res = await getPool().query<ReportRow>(
    `SELECT id, event_id, report_type, title, body, created_by,
            created_at, updated_at, published_at
     FROM event_report WHERE id = $1 AND event_id = $2`,
    [id, eventId]
  );
  return res.rows[0] ? rowToReport(res.rows[0]) : null;
}

export async function createEventReport(data: {
  id: string; eventId: string; reportType: string;
  title: string; body: string; createdBy: string;
}): Promise<EventReport> {
  const res = await getPool().query<ReportRow>(
    `INSERT INTO event_report (id, event_id, report_type, title, body, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, event_id, report_type, title, body, created_by,
               created_at, updated_at, published_at`,
    [data.id, data.eventId, data.reportType, data.title, data.body, data.createdBy]
  );
  return rowToReport(res.rows[0]);
}

export async function updateEventReport(
  id: string, eventId: string,
  fields: {
    reportType?: string; title?: string; body?: string;
    publishedAt?: string | null;
  }
): Promise<EventReport | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id, eventId];
  if (fields.reportType  !== undefined) sets.push(`report_type  = $${vals.push(fields.reportType)}`);
  if (fields.title       !== undefined) sets.push(`title        = $${vals.push(fields.title)}`);
  if (fields.body        !== undefined) sets.push(`body         = $${vals.push(fields.body)}`);
  if (fields.publishedAt !== undefined) sets.push(`published_at = $${vals.push(fields.publishedAt)}`);
  if (!sets.length) return getEventReport(id, eventId);
  sets.push(`updated_at = now()`);
  const res = await getPool().query<ReportRow>(
    `UPDATE event_report SET ${sets.join(", ")} WHERE id = $1 AND event_id = $2
     RETURNING id, event_id, report_type, title, body, created_by,
               created_at, updated_at, published_at`,
    vals
  );
  return res.rows[0] ? rowToReport(res.rows[0]) : null;
}

export async function deleteEventReport(id: string, eventId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM event_report WHERE id = $1 AND event_id = $2",
    [id, eventId]
  );
}

// ─── Report Notes ─────────────────────────────────────────────────────────────

export async function listReportNotes(reportId: string): Promise<EventReportNote[]> {
  const res = await getPool().query<ReportNoteRow>(
    `SELECT id, report_id, department_id, content, author_open_id, author_name,
            created_at, updated_at
     FROM event_report_note WHERE report_id = $1 ORDER BY created_at`,
    [reportId]
  );
  return res.rows.map(rowToReportNote);
}

export async function createReportNote(data: {
  id: string; reportId: string; departmentId: string;
  content: string; authorOpenId: string; authorName: string;
}): Promise<EventReportNote> {
  const res = await getPool().query<ReportNoteRow>(
    `INSERT INTO event_report_note
       (id, report_id, department_id, content, author_open_id, author_name)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, report_id, department_id, content, author_open_id, author_name,
               created_at, updated_at`,
    [data.id, data.reportId, data.departmentId, data.content, data.authorOpenId, data.authorName]
  );
  return rowToReportNote(res.rows[0]);
}

export async function updateReportNote(
  id: string, reportId: string, content: string
): Promise<EventReportNote | null> {
  const res = await getPool().query<ReportNoteRow>(
    `UPDATE event_report_note SET content = $1, updated_at = now()
     WHERE id = $2 AND report_id = $3
     RETURNING id, report_id, department_id, content, author_open_id, author_name,
               created_at, updated_at`,
    [content, id, reportId]
  );
  return res.rows[0] ? rowToReportNote(res.rows[0]) : null;
}

export async function deleteReportNote(
  id: string, reportId: string, openId: string, isAdmin: boolean
): Promise<boolean> {
  const res = isAdmin
    ? await getPool().query(
        "DELETE FROM event_report_note WHERE id = $1 AND report_id = $2 RETURNING id",
        [id, reportId]
      )
    : await getPool().query(
        "DELETE FROM event_report_note WHERE id = $1 AND report_id = $2 AND author_open_id = $3 RETURNING id",
        [id, reportId, openId]
      );
  return res.rows.length > 0;
}

export async function getReportNote(id: string, reportId: string): Promise<EventReportNote | null> {
  const res = await getPool().query<ReportNoteRow>(
    `SELECT id, report_id, department_id, content, author_open_id, author_name,
            created_at, updated_at
     FROM event_report_note WHERE id = $1 AND report_id = $2`,
    [id, reportId]
  );
  return res.rows[0] ? rowToReportNote(res.rows[0]) : null;
}

// ─── Report read receipts ─────────────────────────────────────────────────────

export async function markReportRead(reportId: string, openId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO event_report_read (report_id, open_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [reportId, openId]
  );
}

export async function listUnreadFollowedReports(openId: string, productionId?: string): Promise<UnreadReportEntry[]> {
  const params: unknown[] = [openId];
  const prodFilter = productionId ? `AND pe.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{
    report_id: string; report_title: string; published_at: Date;
    event_id: string; event_title: string; production_id: string; production_name: string;
  }>(
    `SELECT er.id AS report_id, er.title AS report_title, er.published_at,
            pe.id AS event_id, pe.title AS event_title,
            pe.production_id, p.name AS production_name
     FROM event_report er
     JOIN production_event pe ON pe.id = er.event_id
     JOIN production p ON p.id = pe.production_id
     JOIN event_participant ep ON ep.event_id = pe.id AND ep.open_id = $1
     WHERE er.published_at IS NOT NULL
       AND pe.status IN ('published', 'completed')
       ${prodFilter}
       AND NOT EXISTS (
         SELECT 1 FROM event_report_read err
         WHERE err.report_id = er.id AND err.open_id = $1
       )
     ORDER BY er.published_at DESC
     LIMIT 20`,
    params
  );
  return res.rows.map(r => ({
    reportId: r.report_id,
    reportTitle: r.report_title,
    publishedAt: r.published_at.toISOString(),
    eventId: r.event_id,
    eventTitle: r.event_title,
    productionId: r.production_id,
    productionName: r.production_name,
  }));
}

// ─── Self-follow ──────────────────────────────────────────────────────────────

/** Add self as follower. If already a participant (any role), leaves the record unchanged. */
export async function selfFollowEvent(
  eventId: string, openId: string, name: string,
): Promise<void> {
  const id = `ef${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await getPool().query(
    `INSERT INTO event_participant (id, event_id, open_id, name, role)
     VALUES ($1, $2, $3, $4, 'follower')
     ON CONFLICT (event_id, open_id) DO NOTHING`,
    [id, eventId, openId, name]
  );
}

/** Remove self as follower. Only deletes if role='follower'; leaves participants untouched. */
export async function selfUnfollowEvent(eventId: string, openId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM event_participant
     WHERE event_id = $1 AND open_id = $2 AND role = 'follower'`,
    [eventId, openId]
  );
}

/** Returns the current user's participant role in an event, or null if not present. */
export async function getSelfParticipantRole(
  eventId: string, openId: string,
): Promise<"participant" | "follower" | null> {
  const res = await getPool().query<{ role: string }>(
    "SELECT role FROM event_participant WHERE event_id = $1 AND open_id = $2",
    [eventId, openId]
  );
  return (res.rows[0]?.role as "participant" | "follower") ?? null;
}

/** All call times for a specific user in a specific event. */
export async function listUserCallTimes(eventId: string, openId: string): Promise<EventCallTime[]> {
  const res = await getPool().query<CallTimeRow>(
    `SELECT id, event_id, open_id, name, department_id, call_at, schedule_item_id, notes
     FROM event_call_time WHERE event_id = $1 AND open_id = $2 ORDER BY call_at`,
    [eventId, openId]
  );
  return res.rows.map(rowToCallTime);
}

/** True if the user is an assignee of at least one tech req in the event. */
export async function isUserEventTechAssignee(eventId: string, openId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_tech_assignee eta
       JOIN event_tech_req etr ON etr.id = eta.req_id
       WHERE etr.event_id = $1 AND eta.open_id = $2
     ) AS exists`,
    [eventId, openId]
  );
  return res.rows[0].exists;
}

/** True if the user is an assignee of a specific tech req. */
export async function isUserReqAssignee(reqId: string, openId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_tech_assignee WHERE req_id = $1 AND open_id = $2
     ) AS exists`,
    [reqId, openId]
  );
  return res.rows[0].exists;
}

/** True if the user is a POC of a specific department. */
export async function isUserDeptPoc(deptId: string, openId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_department_member
       WHERE department_id = $1 AND open_id = $2 AND is_poc = true
     ) AS exists`,
    [deptId, openId]
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
  assignees: { openId: string; name: string }[];
  deptPeople: { openId: string; name: string }[];
  amPoc: boolean;
};

/** All tech reqs relevant to the user as POC or assignee, with full details for the personal page. */
export async function listMyTechReqsFull(openId: string): Promise<MyTechReqFullEntry[]> {
  const res = await getPool().query<{
    id: string; title: string; description: string; status: string;
    department_id: string | null; department_name: string | null;
    event_id: string; event_title: string;
    production_id: string; production_name: string;
    am_poc: boolean;
    assignees_json: { openId: string; name: string }[] | null;
    dept_people_json: { openId: string; name: string }[] | null;
  }>(
    `SELECT
       etr.id, etr.title, etr.description, etr.status, etr.department_id,
       ed.name AS department_name,
       pe.id AS event_id, pe.title AS event_title,
       pe.production_id, p.name AS production_name,
       (edm_poc.open_id IS NOT NULL) AS am_poc,
       (
         SELECT json_agg(json_build_object('openId', eta2.open_id, 'name', fu2.name)
                ORDER BY fu2.name)
         FROM event_tech_assignee eta2
         JOIN feishu_user fu2 ON fu2.open_id = eta2.open_id
         WHERE eta2.req_id = etr.id
       ) AS assignees_json,
       (
         SELECT json_agg(json_build_object('openId', edm2.open_id, 'name', fu3.name)
                ORDER BY fu3.name)
         FROM event_department_member edm2
         JOIN feishu_user fu3 ON fu3.open_id = edm2.open_id
         WHERE edm2.department_id = etr.department_id
           AND (edm2.is_member OR edm2.is_poc)
       ) AS dept_people_json
     FROM event_tech_req etr
     JOIN production_event pe ON pe.id = etr.event_id
     JOIN production p ON p.id = pe.production_id
     LEFT JOIN event_department ed ON ed.id = etr.department_id
     LEFT JOIN event_department_member edm_poc
       ON edm_poc.department_id = etr.department_id
       AND edm_poc.open_id = $1 AND edm_poc.is_poc = true
     LEFT JOIN event_tech_assignee eta
       ON eta.req_id = etr.id AND eta.open_id = $1
     WHERE pe.status != 'cancelled'
       AND (
         (etr.status = 'awaiting' AND edm_poc.open_id IS NOT NULL)
         OR (etr.status != 'awaiting' AND (eta.open_id IS NOT NULL OR edm_poc.open_id IS NOT NULL))
       )
     ORDER BY pe.start_time NULLS LAST, etr.created_at`,
    [openId]
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

/** Batch-load the current user's participant role across all events in a production. */
export async function listUserEventParticipations(
  openId: string, productionId: string,
): Promise<{ eventId: string; role: "participant" | "follower" }[]> {
  const res = await getPool().query<{ event_id: string; role: string }>(
    `SELECT ep.event_id, ep.role
     FROM event_participant ep
     JOIN production_event pe ON pe.id = ep.event_id
     WHERE ep.open_id = $1 AND pe.production_id = $2`,
    [openId, productionId]
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
  departmentName: string | null;
};

export async function listMyPocAwaitingReqs(openId: string, productionId?: string): Promise<MyPocAwaitingReqEntry[]> {
  const params: unknown[] = [openId];
  const prodFilter = productionId ? `AND pe.production_id = $${params.push(productionId)}` : "";
  const res = await getPool().query<{
    id: string; event_id: string; event_title: string; department_name: string | null;
  }>(
    `SELECT etr.id, pe.id AS event_id, pe.title AS event_title, ed.name AS department_name
     FROM event_tech_req etr
     JOIN production_event pe ON pe.id = etr.event_id
     LEFT JOIN event_department ed ON ed.id = etr.department_id
     JOIN event_department_member edm_poc
       ON edm_poc.department_id = etr.department_id
       AND edm_poc.open_id = $1 AND edm_poc.is_poc = true
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
    departmentName: r.department_name,
  }));
}

export async function listMyUpcomingCallTimes(openId: string, productionId?: string): Promise<MyCallTimeEntry[]> {
  const params: unknown[] = [openId];
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
     WHERE ect.open_id = $1
       AND pe.status = 'published'
       AND ect.call_at >= now()
       AND ect.call_at <= now() + interval '7 days'
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

export async function listMyFollowedUpcomingEvents(openId: string): Promise<MyFollowedEventEntry[]> {
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
     WHERE ep.open_id = $1 AND ep.role = 'follower'
       AND pe.status = 'published'
       AND (pe.start_time IS NULL OR pe.start_time >= now())
     ORDER BY pe.start_time NULLS LAST`,
    [openId]
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

export async function listMyPendingTechReqs(openId: string, productionId?: string): Promise<MyPendingTechReqEntry[]> {
  const params: unknown[] = [openId];
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
     JOIN event_tech_assignee eta ON eta.req_id = etr.id AND eta.open_id = $1
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
  openId: string;
  authorName: string;
  content: string;
  createdAt: string;
};

type ReplyRow = {
  id: string; report_id: string; parent_type: string; parent_id: string;
  open_id: string; author_name: string; content: string; created_at: Date;
};

function rowToReply(r: ReplyRow): ReportReply {
  return {
    id: r.id, reportId: r.report_id,
    parentType: r.parent_type as ReportReply["parentType"],
    parentId: r.parent_id, openId: r.open_id, authorName: r.author_name,
    content: r.content, createdAt: r.created_at.toISOString(),
  };
}

export async function listReportReplies(reportId: string): Promise<ReportReply[]> {
  const res = await getPool().query<ReplyRow>(
    `SELECT id, report_id, parent_type, parent_id, open_id, author_name, content, created_at
     FROM event_report_reply WHERE report_id = $1 ORDER BY created_at ASC`,
    [reportId]
  );
  return res.rows.map(rowToReply);
}

export async function createReportReply(params: {
  id: string; reportId: string; parentType: ReportReply["parentType"];
  parentId: string; openId: string; authorName: string; content: string;
}): Promise<ReportReply> {
  const res = await getPool().query<ReplyRow>(
    `INSERT INTO event_report_reply
       (id, report_id, parent_type, parent_id, open_id, author_name, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, report_id, parent_type, parent_id, open_id, author_name, content, created_at`,
    [params.id, params.reportId, params.parentType, params.parentId,
     params.openId, params.authorName, params.content]
  );
  return rowToReply(res.rows[0]);
}

export async function getReportReply(id: string, reportId: string): Promise<ReportReply | null> {
  const res = await getPool().query<ReplyRow>(
    `SELECT id, report_id, parent_type, parent_id, open_id, author_name, content, created_at
     FROM event_report_reply WHERE id = $1 AND report_id = $2`,
    [id, reportId]
  );
  return res.rows[0] ? rowToReply(res.rows[0]) : null;
}

export async function deleteReportReply(id: string, reportId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM event_report_reply WHERE id = $1 AND report_id = $2",
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
    "UPDATE event_department SET chat_id = $1 WHERE id = $2",
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
    "SELECT chat_id FROM event_department WHERE production_id = $1 AND chat_id IS NOT NULL",
    [productionId]
  );
  return new Set(res.rows.map(r => r.chat_id));
}

/** Returns current dept member entries — used to compute diff for Feishu sync. */
export async function getDepartmentCurrentEntries(
  deptId: string
): Promise<{ openId: string; isMember: boolean; isPoc: boolean }[]> {
  const res = await getPool().query<{ open_id: string; is_member: boolean; is_poc: boolean }>(
    "SELECT open_id, is_member, is_poc FROM event_department_member WHERE department_id = $1",
    [deptId]
  );
  return res.rows.map(r => ({ openId: r.open_id, isMember: r.is_member, isPoc: r.is_poc }));
}

/** Returns all open IDs that should be in an event's group chat (participants + call-time people). */
export async function getEventChatTargets(eventId: string): Promise<string[]> {
  const [partRes, ctRes] = await Promise.all([
    getPool().query<{ open_id: string }>(
      "SELECT open_id FROM event_participant WHERE event_id = $1",
      [eventId]
    ),
    getPool().query<{ open_id: string }>(
      "SELECT DISTINCT open_id FROM event_call_time WHERE event_id = $1",
      [eventId]
    ),
  ]);
  const ids = new Set<string>();
  for (const r of partRes.rows) ids.add(r.open_id);
  for (const r of ctRes.rows) ids.add(r.open_id);
  return [...ids];
}

/** Returns all open IDs that should be in a req's group chat (assignees + dept POCs). */
export async function getReqChatTargets(reqId: string): Promise<string[]> {
  const [assigneeRes, pocRes] = await Promise.all([
    getPool().query<{ open_id: string }>(
      "SELECT open_id FROM event_tech_assignee WHERE req_id = $1",
      [reqId]
    ),
    getPool().query<{ open_id: string }>(
      `SELECT edm.open_id FROM event_tech_req etr
       JOIN event_department_member edm ON edm.department_id = etr.department_id AND edm.is_poc = true
       WHERE etr.id = $1`,
      [reqId]
    ),
  ]);
  const ids = new Set<string>();
  for (const r of assigneeRes.rows) ids.add(r.open_id);
  for (const r of pocRes.rows) ids.add(r.open_id);
  return [...ids];
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
