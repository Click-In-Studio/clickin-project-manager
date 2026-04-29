import { getScriptEditorPool } from "./db";

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
  stageManagers: { name: string; openId: string }[];
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
      stage_managers: { name: string; open_id: string }[] | null;
    }>(
      `SELECT pe.id, pe.title, pe.event_type, pe.location, pe.start_time, pe.end_time,
              pe.status, pe.description,
              json_agg(json_build_object('name', esm.name, 'open_id', esm.open_id))
                FILTER (WHERE esm.open_id IS NOT NULL) AS stage_managers
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
                FILTER (WHERE sip.open_id IS NOT NULL) AS participants
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
       LEFT JOIN event_call_time ect ON ect.event_id = $1 AND ect.open_id = ep.open_id
       LEFT JOIN event_schedule_item esi ON esi.id = ect.schedule_item_id
       WHERE ep.event_id = $1
       GROUP BY ep.open_id, ep.name, ep.role, ed.name
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
    stageManagers: (ev.stage_managers ?? []).map(sm => ({ name: sm.name, openId: sm.open_id })),
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
