import { getScriptEditorPool } from "./db";

// ── Call / tech-req types for personal queries ────────────────────────────────

export type UserCallEntry = {
  callAt: Date;
  callNotes: string;
  eventId: string;
  eventTitle: string;
  eventLocation: string;
  productionName: string;
  scheduleItems: { title: string; startTime: Date | null }[];
};

export type MyTechReqEntry = {
  id: string;
  title: string;
  status: string;
  role: "assignee" | "poc";
  eventId: string;
  eventTitle: string;
  productionName: string;
  departmentName: string | null;
};

/** Call times for a specific user on a given date (YYYY-MM-DD CST, default today). */
export async function getDailyCallForUser(userId: string, dateStr?: string): Promise<UserCallEntry[]> {
  const pool = getScriptEditorPool();
  const d = dateStr ?? (() => {
    const nowCst = new Date(Date.now() + 8 * 3_600_000);
    return `${nowCst.getUTCFullYear()}-${String(nowCst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowCst.getUTCDate()).padStart(2, "0")}`;
  })();

  const [callsRes] = await Promise.all([
    pool.query<{
      call_at: Date; call_notes: string;
      event_id: string; event_title: string; event_location: string; production_name: string;
    }>(
      `SELECT ect.call_at, ect.notes AS call_notes,
              pe.id AS event_id, pe.title AS event_title,
              pe.location AS event_location, p.name AS production_name
       FROM event_call_time ect
       JOIN production_event pe ON pe.id = ect.event_id
       JOIN production p ON p.id = pe.production_id
       WHERE ect.user_id = $1 AND ect.call_at >= $2 AND ect.call_at < $3
       ORDER BY ect.call_at`,
      [userId, `${d}T00:00:00+08:00`, `${d}T23:59:59.999+08:00`],
    ),
  ]);

  if (!callsRes.rows.length) return [];

  const eventIds = [...new Set(callsRes.rows.map(r => r.event_id))];
  const schedRes = await pool.query<{ event_id: string; title: string; start_time: Date | null }>(
    `SELECT event_id, title, start_time FROM event_schedule_item
     WHERE event_id = ANY($1) ORDER BY event_id, order_index`,
    [eventIds],
  );
  const schedByEvent = new Map<string, { title: string; startTime: Date | null }[]>();
  for (const r of schedRes.rows) {
    if (!schedByEvent.has(r.event_id)) schedByEvent.set(r.event_id, []);
    schedByEvent.get(r.event_id)!.push({ title: r.title, startTime: r.start_time });
  }

  return callsRes.rows.map(r => ({
    callAt: r.call_at,
    callNotes: r.call_notes,
    eventId: r.event_id,
    eventTitle: r.event_title,
    eventLocation: r.event_location,
    productionName: r.production_name,
    scheduleItems: schedByEvent.get(r.event_id) ?? [],
  }));
}

/** Call times for a specific user over the next 7 days (CST). */
export async function getWeeklyCallForUser(userId: string): Promise<UserCallEntry[]> {
  const pool = getScriptEditorPool();
  const nowCst = new Date(Date.now() + 8 * 3_600_000);
  const todayStr = `${nowCst.getUTCFullYear()}-${String(nowCst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowCst.getUTCDate()).padStart(2, "0")}`;
  const weekStart = `${todayStr}T00:00:00+08:00`;
  const weekEnd   = new Date(Date.UTC(
    nowCst.getUTCFullYear(), nowCst.getUTCMonth(), nowCst.getUTCDate() + 7, 16, 0, 0,
  )).toISOString(); // D+7 00:00 CST = D+6 16:00 UTC

  const callsRes = await pool.query<{
    call_at: Date; call_notes: string;
    event_id: string; event_title: string; event_location: string; production_name: string;
  }>(
    `SELECT ect.call_at, ect.notes AS call_notes,
            pe.id AS event_id, pe.title AS event_title,
            pe.location AS event_location, p.name AS production_name
     FROM event_call_time ect
     JOIN production_event pe ON pe.id = ect.event_id
     JOIN production p ON p.id = pe.production_id
     WHERE ect.user_id = $1 AND ect.call_at >= $2 AND ect.call_at < $3
     ORDER BY ect.call_at`,
    [userId, weekStart, weekEnd],
  );

  if (!callsRes.rows.length) return [];

  const eventIds = [...new Set(callsRes.rows.map(r => r.event_id))];
  const schedRes = await pool.query<{ event_id: string; title: string; start_time: Date | null }>(
    `SELECT event_id, title, start_time FROM event_schedule_item
     WHERE event_id = ANY($1) ORDER BY event_id, order_index`,
    [eventIds],
  );
  const schedByEvent = new Map<string, { title: string; startTime: Date | null }[]>();
  for (const r of schedRes.rows) {
    if (!schedByEvent.has(r.event_id)) schedByEvent.set(r.event_id, []);
    schedByEvent.get(r.event_id)!.push({ title: r.title, startTime: r.start_time });
  }

  return callsRes.rows.map(r => ({
    callAt: r.call_at,
    callNotes: r.call_notes,
    eventId: r.event_id,
    eventTitle: r.event_title,
    eventLocation: r.event_location,
    productionName: r.production_name,
    scheduleItems: schedByEvent.get(r.event_id) ?? [],
  }));
}

/** Unfinished tech reqs where the user is assignee (non-done) or dept POC (awaiting). */
export async function getMyTechReqs(userId: string): Promise<MyTechReqEntry[]> {
  const pool = getScriptEditorPool();
  const res = await pool.query<{
    id: string; title: string; status: string; role: string;
    event_id: string; event_title: string;
    production_name: string; department_name: string | null;
  }>(
    `SELECT etr.id, etr.title, etr.status, 'assignee' AS role,
            pe.id AS event_id, pe.title AS event_title,
            p.name AS production_name, ed.name AS department_name
     FROM event_tech_req etr
     JOIN event_tech_assignee eta ON eta.req_id = etr.id AND eta.user_id = $1
     JOIN production_event pe ON pe.id = etr.event_id
     JOIN production p ON p.id = pe.production_id
     LEFT JOIN event_department ed ON ed.id = etr.department_id
     WHERE etr.status NOT IN ('done', 'cancelled')
       AND pe.status NOT IN ('completed', 'cancelled')
     UNION
     SELECT etr.id, etr.title, etr.status, 'poc' AS role,
            pe.id AS event_id, pe.title AS event_title,
            p.name AS production_name, ed.name AS department_name
     FROM event_tech_req etr
     JOIN event_department ed ON ed.id = etr.department_id
     JOIN event_department_member edm
       ON edm.department_id = etr.department_id AND edm.user_id = $1 AND edm.is_poc = true
     JOIN production_event pe ON pe.id = etr.event_id
     JOIN production p ON p.id = pe.production_id
     WHERE etr.status = 'awaiting'
       AND pe.status NOT IN ('completed', 'cancelled')
     ORDER BY event_title, title`,
    [userId],
  );
  return res.rows.map(r => ({
    id: r.id, title: r.title, status: r.status,
    role: r.role as "assignee" | "poc",
    eventId: r.event_id, eventTitle: r.event_title,
    productionName: r.production_name, departmentName: r.department_name,
  }));
}

// ── Filter types ───────────────────────────────────────────────────────────────

export type EventFilters = {
  status?: string[];
  dateFrom?: string;         // YYYY-MM-DD, Beijing time (inclusive)
  dateTo?: string;           // YYYY-MM-DD, Beijing time (inclusive)
  title?: string;            // ILIKE match
  eventType?: string[];
  participantName?: string;  // ILIKE match on participant name
  techReqKeyword?: string;   // ILIKE match on tech req title / description
};

// ── Basic info (query result) ─────────────────────────────────────────────────

export type EventBasicInfo = {
  id: string;
  title: string;
  eventType: string;
  location: string;
  startTime: Date | null;
  endTime: Date | null;
  status: string;
  description: string;
  stageManagers: string[];
};

export async function queryEvents(
  productionId: string,
  filters: EventFilters,
): Promise<EventBasicInfo[]> {
  const pool = getScriptEditorPool();
  const conds: string[] = ["pe.production_id = $1"];
  const params: unknown[] = [productionId];
  let p = 2;

  if (filters.status?.length) {
    conds.push(`pe.status = ANY($${p}::text[])`);
    params.push(filters.status); p++;
  }
  if (filters.dateFrom) {
    conds.push(`(pe.start_time IS NULL OR pe.start_time >= $${p}::timestamptz)`);
    params.push(`${filters.dateFrom}T00:00:00+08:00`); p++;
  }
  if (filters.dateTo) {
    conds.push(`(pe.start_time IS NULL OR pe.start_time <= $${p}::timestamptz)`);
    params.push(`${filters.dateTo}T23:59:59+08:00`); p++;
  }
  if (filters.title) {
    conds.push(`pe.title ILIKE $${p}`);
    params.push(`%${filters.title}%`); p++;
  }
  if (filters.eventType?.length) {
    conds.push(`pe.event_type = ANY($${p}::text[])`);
    params.push(filters.eventType); p++;
  }
  if (filters.participantName) {
    conds.push(
      `EXISTS (SELECT 1 FROM event_participant ep WHERE ep.event_id = pe.id AND ep.name ILIKE $${p})`,
    );
    params.push(`%${filters.participantName}%`); p++;
  }
  if (filters.techReqKeyword) {
    conds.push(
      `EXISTS (SELECT 1 FROM event_tech_req etr WHERE etr.event_id = pe.id AND (etr.title ILIKE $${p} OR etr.description ILIKE $${p}))`,
    );
    params.push(`%${filters.techReqKeyword}%`); p++;
  }

  const sql = `
    SELECT pe.id, pe.title, pe.event_type, pe.location,
           pe.start_time, pe.end_time, pe.status, pe.description,
           COALESCE(array_agg(DISTINCT esm.name) FILTER (WHERE esm.name IS NOT NULL), '{}') AS stage_managers
    FROM production_event pe
    LEFT JOIN event_stage_manager esm ON esm.event_id = pe.id
    WHERE ${conds.join(" AND ")}
    GROUP BY pe.id
    ORDER BY pe.start_time ASC NULLS LAST
    LIMIT 50
  `;

  const res = await pool.query<{
    id: string; title: string; event_type: string; location: string;
    start_time: Date | null; end_time: Date | null; status: string;
    description: string; stage_managers: string[];
  }>(sql, params);

  return res.rows.map(r => ({
    id: r.id, title: r.title, eventType: r.event_type, location: r.location,
    startTime: r.start_time, endTime: r.end_time, status: r.status,
    description: r.description, stageManagers: r.stage_managers,
  }));
}

// ── Detail types ───────────────────────────────────────────────────────────────

export type EventDetail = {
  id: string;
  title: string;
  eventType: string;
  location: string;
  startTime: Date | null;
  endTime: Date | null;
  status: string;
  description: string;
  stageManagers: { name: string }[];
  scheduleItems: {
    id: string;
    title: string;
    itemType: string;
    startTime: Date | null;
    endTime: Date | null;
    location: string;
    notes: string;
    sceneName: string | null;
    participants: string[];
  }[];
  participants: {
    name: string;
    role: string;
    departmentName: string | null;
    callTimes: { callAt: Date; notes: string; scheduleItemTitle: string | null }[];
  }[];
  techReqs: {
    title: string;
    description: string;
    status: string;
    presetMinutes: number | null;
    departmentName: string | null;
    assignees: string[];
    scheduleItemTitles: string[];
  }[];
  reports: {
    title: string;
    reportType: string;
    body: string;
    publishedAt: Date | null;
    notes: { departmentName: string; content: string; authorName: string }[];
  }[];
  callSheet: {
    name: string;
    callAt: Date;
    notes: string;
    departmentName: string | null;
    scheduleItemTitle: string | null;
  }[];
};

export async function getEventDetail(
  eventId: string,
  productionId: string,
): Promise<EventDetail | null> {
  const pool = getScriptEditorPool();

  const [evRes, schedRes, partRes, techRes, repRes, callRes] = await Promise.all([
    // 1. Basic info + stage managers
    pool.query<{
      id: string; title: string; event_type: string; location: string;
      start_time: Date | null; end_time: Date | null; status: string; description: string;
      stage_managers: { name: string }[] | null;
    }>(
      `SELECT pe.id, pe.title, pe.event_type, pe.location, pe.start_time, pe.end_time,
              pe.status, pe.description,
              json_agg(json_build_object('name', esm.name))
                FILTER (WHERE esm.user_id IS NOT NULL) AS stage_managers
       FROM production_event pe
       LEFT JOIN event_stage_manager esm ON esm.event_id = pe.id
       WHERE pe.id = $1 AND pe.production_id = $2
       GROUP BY pe.id`,
      [eventId, productionId],
    ),

    // 2. Schedule items + per-item participants
    pool.query<{
      id: string; title: string; item_type: string;
      start_time: Date | null; end_time: Date | null;
      location: string; notes: string; scene_name: string | null;
      participants: { name: string }[] | null;
    }>(
      `SELECT esi.id, esi.title, esi.item_type, esi.start_time, esi.end_time,
              esi.location, esi.notes, s.name AS scene_name,
              json_agg(json_build_object('name', sip.name))
                FILTER (WHERE sip.user_id IS NOT NULL) AS participants
       FROM event_schedule_item esi
       LEFT JOIN scene s ON s.id = esi.target_scene_id
       LEFT JOIN schedule_item_participant sip ON sip.item_id = esi.id
       WHERE esi.event_id = $1
       GROUP BY esi.id, s.name
       ORDER BY esi.order_index`,
      [eventId],
    ),

    // 3. Participants + call times
    pool.query<{
      name: string; role: string; department_name: string | null;
      call_times: { call_at: string; notes: string; schedule_item_title: string | null }[] | null;
    }>(
      `SELECT ep.name, ep.role, ed.name AS department_name,
              json_agg(
                json_build_object(
                  'call_at', ect.call_at,
                  'notes', ect.notes,
                  'schedule_item_title', esi.title
                ) ORDER BY ect.call_at
              ) FILTER (WHERE ect.id IS NOT NULL) AS call_times
       FROM event_participant ep
       LEFT JOIN event_department ed ON ed.id = ep.department_id
       LEFT JOIN event_call_time ect ON ect.event_id = $1 AND ect.user_id = ep.user_id
       LEFT JOIN event_schedule_item esi ON esi.id = ect.schedule_item_id
       WHERE ep.event_id = $1
       GROUP BY ep.user_id, ep.name, ep.role, ed.name
       ORDER BY ep.name`,
      [eventId],
    ),

    // 4. Tech requirements + assignees + linked schedule items
    pool.query<{
      title: string; description: string; status: string; preset_minutes: number | null;
      department_name: string | null; assignees: string[] | null; schedule_item_titles: string[] | null;
    }>(
      `SELECT etr.title, etr.description, etr.status, etr.preset_minutes,
              ed.name AS department_name,
              array_agg(DISTINCT eta.name) FILTER (WHERE eta.name IS NOT NULL) AS assignees,
              array_agg(DISTINCT esi.title) FILTER (WHERE esi.title IS NOT NULL) AS schedule_item_titles
       FROM event_tech_req etr
       LEFT JOIN event_department ed ON ed.id = etr.department_id
       LEFT JOIN event_tech_assignee eta ON eta.req_id = etr.id
       LEFT JOIN event_tech_req_item etri ON etri.req_id = etr.id
       LEFT JOIN event_schedule_item esi ON esi.id = etri.item_id
       WHERE etr.event_id = $1
       GROUP BY etr.id, etr.title, etr.description, etr.status, etr.preset_minutes, ed.name
       ORDER BY etr.created_at`,
      [eventId],
    ),

    // 5. Reports + department notes
    pool.query<{
      title: string; report_type: string; body: string; published_at: Date | null;
      notes: { department_name: string; content: string; author_name: string }[] | null;
    }>(
      `SELECT er.title, er.report_type, er.body, er.published_at,
              json_agg(
                json_build_object(
                  'department_name', ed.name,
                  'content', ern.content,
                  'author_name', ern.author_name
                ) ORDER BY ed.display_order
              ) FILTER (WHERE ern.id IS NOT NULL) AS notes
       FROM event_report er
       LEFT JOIN event_report_note ern ON ern.report_id = er.id
       LEFT JOIN event_department ed ON ed.id = ern.department_id
       WHERE er.event_id = $1
       GROUP BY er.id
       ORDER BY er.created_at DESC`,
      [eventId],
    ),

    // 6. Call sheet — all call times chronologically, direct from event_call_time
    pool.query<{
      name: string; call_at: Date; notes: string;
      department_name: string | null; schedule_item_title: string | null;
    }>(
      `SELECT ect.name, ect.call_at, ect.notes,
              ed.name AS department_name,
              esi.title AS schedule_item_title
       FROM event_call_time ect
       LEFT JOIN event_department ed ON ed.id = ect.department_id
       LEFT JOIN event_schedule_item esi ON esi.id = ect.schedule_item_id
       WHERE ect.event_id = $1
       ORDER BY ect.call_at, ect.name`,
      [eventId],
    ),
  ]);

  if ((evRes.rowCount ?? 0) === 0) return null;
  const ev = evRes.rows[0];

  return {
    id: ev.id, title: ev.title, eventType: ev.event_type, location: ev.location,
    startTime: ev.start_time, endTime: ev.end_time, status: ev.status, description: ev.description,
    stageManagers: (ev.stage_managers ?? []).map(sm => ({ name: sm.name })),
    scheduleItems: schedRes.rows.map(r => ({
      id: r.id, title: r.title, itemType: r.item_type,
      startTime: r.start_time, endTime: r.end_time,
      location: r.location, notes: r.notes, sceneName: r.scene_name,
      participants: (r.participants ?? []).map(p => p.name),
    })),
    participants: partRes.rows.map(r => ({
      name: r.name, role: r.role, departmentName: r.department_name,
      callTimes: (r.call_times ?? []).map(ct => ({
        callAt: new Date(ct.call_at),
        notes: ct.notes,
        scheduleItemTitle: ct.schedule_item_title,
      })),
    })),
    techReqs: techRes.rows.map(r => ({
      title: r.title, description: r.description, status: r.status,
      presetMinutes: r.preset_minutes, departmentName: r.department_name,
      assignees: r.assignees ?? [], scheduleItemTitles: r.schedule_item_titles ?? [],
    })),
    reports: repRes.rows.map(r => ({
      title: r.title, reportType: r.report_type, body: r.body, publishedAt: r.published_at,
      notes: (r.notes ?? []).map(n => ({
        departmentName: n.department_name, content: n.content, authorName: n.author_name,
      })),
    })),
    callSheet: callRes.rows.map(r => ({
      name: r.name, callAt: r.call_at, notes: r.notes,
      departmentName: r.department_name, scheduleItemTitle: r.schedule_item_title,
    })),
  };
}
