import { getPool } from "./pg";

// ─── Result types ────────────────────────────────────────────────────────────

export type EventSearchResult = {
  id: string;
  title: string;
  eventType: string;
  startTime: string | null;
  location: string;
  status: string;
};

export type TechReqSearchResult = {
  id: string;
  title: string;
  status: string;
  eventId: string | null;
  eventTitle: string | null;
  deptName: string | null;
};

export type ContactSearchResult = {
  userId: string;
  name: string;
  roles: string[];
  matchHint: string | null;
};

export type SceneSearchResult = {
  id: string;
  name: string;
  matchHint: string | null;
};

export type CharacterSearchResult = {
  id: string;
  name: string;
  matchHint: string | null;
};

export type AssetSearchResult = {
  id: string;
  name: string | null;
  fileName: string;
  assetType: string;
};

export type ProductionSearchResults = {
  dateQuery: string | null;
  events: EventSearchResult[];
  techReqs: TechReqSearchResult[];
  contacts: ContactSearchResult[];
  scenes: SceneSearchResult[];
  characters: CharacterSearchResult[];
  assets: AssetSearchResult[];
};

// ─── Date detection ──────────────────────────────────────────────────────────

function parseQueryAsDate(q: string): string | null {
  const s = q.trim();

  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  // MM月DD日 or MM月DD号
  m = s.match(/^(\d{1,2})[月](\d{1,2})[日号]?$/);
  if (m) {
    const year = new Date().getFullYear();
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }

  // MM-DD or MM/DD (no year)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const year = new Date().getFullYear();
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }

  return null;
}

// ─── Main search ─────────────────────────────────────────────────────────────

export async function searchProduction(
  productionId: string,
  query: string,
): Promise<ProductionSearchResults> {
  const pool = getPool();
  const q = query.trim();
  const like = `%${q}%`;
  const dateStr = parseQueryAsDate(q);

  const [events, techReqs, contacts, scenes, characters, assets] = await Promise.all([
    // ── Events ────────────────────────────────────────────────────────────────
    dateStr
      ? pool.query<{
          id: string; title: string; event_type: string;
          start_time: Date | null; location: string; status: string;
        }>(
          `SELECT id, title, event_type, start_time, location, status
           FROM production_event
           WHERE production_id = $1
             AND DATE(start_time AT TIME ZONE 'Asia/Shanghai') = $2::date
           ORDER BY start_time NULLS LAST
           LIMIT 10`,
          [productionId, dateStr],
        )
      : pool.query<{
          id: string; title: string; event_type: string;
          start_time: Date | null; location: string; status: string;
        }>(
          `SELECT id, title, event_type, start_time, location, status
           FROM production_event
           WHERE production_id = $1
             AND (title ILIKE $2 OR location ILIKE $2)
           ORDER BY start_time NULLS LAST
           LIMIT 5`,
          [productionId, like],
        ),

    // ── Tech Reqs (title + dept name + assignee name snapshot) ───────────────
    pool.query<{
      id: string; title: string; status: string;
      event_id: string; event_title: string; dept_name: string | null;
    }>(
      `SELECT etr.id, etr.title, etr.status,
              pe.id AS event_id, pe.title AS event_title,
              ed.name AS dept_name
       FROM task etr
       LEFT JOIN production_event pe ON pe.id = etr.event_id
       LEFT JOIN production_dept ed ON ed.id = etr.department_id
       WHERE etr.production_id = $1
         AND (
           etr.title ILIKE $2
           OR ed.name ILIKE $2
           OR EXISTS (
             SELECT 1 FROM task_assignee eta
             WHERE eta.task_id = etr.id AND eta.name ILIKE $2
           )
         )
       LIMIT 5`,
      [productionId, like],
    ),

    // ── Contacts (name / roles array / department name) ───────────────────────
    pool.query<{ user_id: string; name: string; roles: string[]; match_hint: string | null }>(
      `SELECT pm.user_id, COALESCE(up.name, '') AS name, pm.roles,
              CASE
                WHEN up.name ILIKE $2 THEN NULL
                WHEN EXISTS (SELECT 1 FROM unnest(pm.roles) AS r WHERE r ILIKE $2) THEN NULL
                ELSE (
                  SELECT '部门: ' || ed.name
                  FROM production_dept_member edm
                  JOIN production_dept ed ON ed.id = edm.dept_id
                  WHERE edm.user_id = pm.user_id
                    AND ed.production_id = $1
                    AND ed.name ILIKE $2
                  LIMIT 1
                )
              END AS match_hint
       FROM production_member pm
       LEFT JOIN user_profile up ON up.user_id = pm.user_id
       WHERE pm.production_id = $1 AND pm.status = 'active'
         AND (
           up.name ILIKE $2
           OR EXISTS (SELECT 1 FROM unnest(pm.roles) AS r WHERE r ILIKE $2)
           OR EXISTS (
             SELECT 1 FROM production_dept_member edm
             JOIN production_dept ed ON ed.id = edm.dept_id
             WHERE edm.user_id = pm.user_id
               AND ed.production_id = $1
               AND ed.name ILIKE $2
           )
         )
       ORDER BY up.name NULLS LAST
       LIMIT 5`,
      [productionId, like],
    ),

    // ── Scenes (active version, name + dramaturgy fields) ─────────────────────
    pool.query<{ id: string; name: string; match_hint: string | null }>(
      `SELECT sv.scene_id AS id, sv.name,
              CASE
                WHEN sv.name ILIKE $2 THEN NULL
                WHEN sv.synopsis ILIKE $2 THEN '简介 · ' || LEFT(sv.synopsis, 35)
                WHEN sv.action_line ILIKE $2 THEN '行动线 · ' || LEFT(sv.action_line, 35)
                WHEN sv.music ILIKE $2 THEN '音乐 · ' || LEFT(sv.music, 35)
                WHEN sv.stage_notes ILIKE $2 THEN '舞台呈现 · ' || LEFT(sv.stage_notes, 35)
              END AS match_hint
       FROM scene_version sv
       WHERE sv.version_id = (SELECT active_version_id FROM production WHERE id = $1)
         AND (
           sv.name ILIKE $2
           OR COALESCE(sv.synopsis, '') ILIKE $2
           OR COALESCE(sv.action_line, '') ILIKE $2
           OR COALESCE(sv.music, '') ILIKE $2
           OR COALESCE(sv.stage_notes, '') ILIKE $2
         )
       ORDER BY sv.sort_order
       LIMIT 5`,
      [productionId, like],
    ),

    // ── Characters (active version, including aggregates; metadata + constituent names) ──
    pool.query<{ id: string; name: string; match_hint: string | null }>(
      `SELECT cv.character_id AS id, cv.name,
              CASE
                WHEN cv.name ILIKE $2 THEN NULL
                WHEN COALESCE(cv.biography, '') ILIKE $2 THEN '人物小传 · ' || LEFT(cv.biography, 35)
                ELSE '包含角色: ' || (
                  SELECT mcv.name FROM character_aggregate ca
                  JOIN character_version mcv ON mcv.character_id = ca.member_id
                    AND mcv.version_id = cv.version_id
                  WHERE ca.aggregate_id = cv.character_id
                    AND mcv.name ILIKE $2
                  LIMIT 1
                )
              END AS match_hint
       FROM character_version cv
       WHERE cv.version_id = (SELECT active_version_id FROM production WHERE id = $1)
         AND (
           cv.name ILIKE $2
           OR COALESCE(cv.biography, '') ILIKE $2
           OR EXISTS (
             SELECT 1 FROM character_aggregate ca
             JOIN character_version mcv ON mcv.character_id = ca.member_id
               AND mcv.version_id = cv.version_id
             WHERE ca.aggregate_id = cv.character_id
               AND mcv.name ILIKE $2
           )
         )
       ORDER BY cv.sort_order
       LIMIT 5`,
      [productionId, like],
    ),

    // ── Assets ────────────────────────────────────────────────────────────────
    pool.query<{ id: string; name: string | null; file_name: string; asset_type: string }>(
      `SELECT id, name, file_name, asset_type
       FROM asset
       WHERE production_id = $1
         AND (COALESCE(name, '') ILIKE $2 OR file_name ILIKE $2)
       ORDER BY created_at DESC
       LIMIT 5`,
      [productionId, like],
    ),
  ]);

  type EventRow = { id: string; title: string; event_type: string; start_time: Date | null; location: string; status: string };
  type TechReqRow = { id: string; title: string; status: string; event_id: string | null; event_title: string | null; dept_name: string | null };
  type ContactRow = { user_id: string; name: string; roles: string[]; match_hint: string | null };
  type SceneRow = { id: string; name: string; match_hint: string | null };
  type CharRow = { id: string; name: string; match_hint: string | null };
  type AssetRow = { id: string; name: string | null; file_name: string; asset_type: string };

  return {
    dateQuery: dateStr,
    events: (events.rows as EventRow[]).map((r) => ({
      id: r.id,
      title: r.title,
      eventType: r.event_type,
      startTime: r.start_time?.toISOString() ?? null,
      location: r.location,
      status: r.status,
    })),
    techReqs: (techReqs.rows as TechReqRow[]).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      eventId: r.event_id,
      eventTitle: r.event_title,
      deptName: r.dept_name,
    })),
    contacts: (contacts.rows as ContactRow[]).map((r) => ({
      userId: r.user_id,
      name: r.name,
      roles: r.roles,
      matchHint: r.match_hint,
    })),
    scenes: (scenes.rows as SceneRow[]).map((r) => ({ id: r.id, name: r.name, matchHint: r.match_hint })),
    characters: (characters.rows as CharRow[]).map((r) => ({ id: r.id, name: r.name, matchHint: r.match_hint })),
    assets: (assets.rows as AssetRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      fileName: r.file_name,
      assetType: r.asset_type,
    })),
  };
}
