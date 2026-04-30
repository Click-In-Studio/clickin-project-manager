import { getPool } from "./pg";
import type { Block, Character, Scene, ScriptState, ScriptConfig } from "./script-types";
import { DEFAULT_SCRIPT_CONFIG } from "./script-types";
import type { Permission, PermissionOverrides } from "./roles";
import type { Cue, CueAnchor } from "./cue-types";
import { adjustBlockAnchor, lcsAdjust } from "./cue-types";

// ─── Exported types ───────────────────────────────────────────────────────────

export type DbBlock = Block & { orderKey: number; lexKey: string };
export type DbScene = Scene & { sortOrder: number };
export type DbChar = Character & { sortOrder: number };

export type FlushPayload = {
  upsertBlocks: DbBlock[];
  deleteBlockIds: string[];
  upsertChars: DbChar[];
  deleteCharIds: string[];
  upsertScenes: DbScene[];
  deleteSceneIds: string[];
};

// ─── Type conversions ─────────────────────────────────────────────────────────

type DbBlockType = "dialogue" | "stage" | "lyric";

function toDbType(block: Block): DbBlockType {
  if (block.type === "stage") return "stage";
  if (block.lyric) return "lyric";
  return "dialogue";
}

function fromDbType(t: DbBlockType): { type: Block["type"]; lyric: boolean } {
  if (t === "stage") return { type: "stage", lyric: false };
  if (t === "lyric") return { type: "dialogue", lyric: true };
  return { type: "dialogue", lyric: false };
}

// ─── Row types (internal) ─────────────────────────────────────────────────────

type BlockRow = {
  id: string;
  sort_key: string;
  scene_id: string | null;
  rehearsal_mark: string | null;
  type: DbBlockType;
  content: string;
};
type SceneRow = { id: string; num: string; name: string; sort_order: number; parent_id: string | null };
type CharRow  = { id: string; name: string; sort_order: number; is_aggregate: boolean };
type ScCharRow = { script_id: string; character_id: string; annotation: string | null };

// ─── Read ─────────────────────────────────────────────────────────────────────

export type ProductionState = {
  state: ScriptState;
  sortKeys: Map<string, string>; // block_id → sort_key from DB
};

/** Load all data for a production. Returns null if the production doesn't exist. */
export async function loadProduction(productionId: string): Promise<ProductionState | null> {
  const pool = getPool();

  const [[blocksRes, scenesRes, charsRes], prodRes] = await Promise.all([
    Promise.all([
      pool.query<BlockRow>(
        "SELECT id, sort_key, scene_id, rehearsal_mark, type, content FROM script WHERE production_id = $1 ORDER BY sort_key",
        [productionId]
      ),
      pool.query<SceneRow>(
        "SELECT id, num, name, sort_order, parent_id FROM scene WHERE production_id = $1 ORDER BY sort_order",
        [productionId]
      ),
      pool.query<CharRow>(
        "SELECT id, name, sort_order, is_aggregate FROM character WHERE production_id = $1 ORDER BY sort_order",
        [productionId]
      ),
    ]),
    pool.query<{ exists: boolean; script_config: ScriptConfig | null }>(
      "SELECT EXISTS(SELECT 1 FROM production WHERE id = $1) AS exists, (SELECT script_config FROM production WHERE id = $1) AS script_config",
      [productionId]
    ),
  ]);

  const existsRes = prodRes;
  const rawConfig = prodRes.rows[0]?.script_config;

  if (!existsRes.rows[0].exists) return null;

  const blockIds = blocksRes.rows.map(r => r.id);
  const scCharRes = blockIds.length > 0
    ? await pool.query<ScCharRow>(
        "SELECT script_id, character_id, annotation FROM script_character WHERE script_id = ANY($1::text[]) ORDER BY script_id, position",
        [blockIds]
      )
    : { rows: [] as ScCharRow[] };

  const charsByBlock = new Map<string, string[]>();
  const annotationsByBlock = new Map<string, Record<string, string>>();
  for (const row of scCharRes.rows) {
    if (!charsByBlock.has(row.script_id)) charsByBlock.set(row.script_id, []);
    charsByBlock.get(row.script_id)!.push(row.character_id);
    if (row.annotation) {
      if (!annotationsByBlock.has(row.script_id)) annotationsByBlock.set(row.script_id, {});
      annotationsByBlock.get(row.script_id)![row.character_id] = row.annotation;
    }
  }

  const sortKeys = new Map<string, string>();
  const blocks: Block[] = blocksRes.rows.map(row => {
    sortKeys.set(row.id, row.sort_key);
    const { type, lyric } = fromDbType(row.type);
    return {
      id: row.id,
      type,
      lyric,
      content: row.content,
      sceneId: row.scene_id,
      rehearsalMark: row.rehearsal_mark,
      characterIds: charsByBlock.get(row.id) ?? [],
      characterAnnotations: annotationsByBlock.get(row.id) ?? {},
    };
  });

  const config: ScriptConfig = { ...DEFAULT_SCRIPT_CONFIG, ...(rawConfig ?? {}) };

  return {
    state: {
      blocks,
      scenes: scenesRes.rows.map(r => ({ id: r.id, number: r.num, name: r.name, parentId: r.parent_id })),
      characters: charsRes.rows.map(r => ({ id: r.id, name: r.name, isAggregate: r.is_aggregate })),
      config,
    },
    sortKeys,
  };
}

export async function saveScriptConfig(productionId: string, config: ScriptConfig): Promise<void> {
  await getPool().query(
    "UPDATE production SET script_config = $1 WHERE id = $2",
    [JSON.stringify(config), productionId]
  );
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function flushToDB(productionId: string, payload: FlushPayload): Promise<void> {
  const { upsertBlocks, deleteBlockIds, upsertChars, deleteCharIds, upsertScenes, deleteSceneIds } = payload;
  if (!upsertBlocks.length && !deleteBlockIds.length && !upsertChars.length &&
      !deleteCharIds.length && !upsertScenes.length && !deleteSceneIds.length) return;

  // ── Phase 1: snapshot pre-flush state needed for cue drift ────────────────
  const oldContents = new Map<string, string>();
  const blockAdj = new Map<string, { prevId: string | null; nextId: string | null }>();

  if (upsertBlocks.length > 0) {
    const ids = upsertBlocks.map(b => b.id);
    const res = await getPool().query<{ id: string; content: string }>(
      "SELECT id, content FROM script WHERE id = ANY($1::text[])", [ids]
    );
    for (const r of res.rows) oldContents.set(r.id, r.content);
  }

  if (deleteBlockIds.length > 0) {
    const res = await getPool().query<{ id: string; prev_id: string | null; next_id: string | null }>(
      `WITH ordered AS (
         SELECT id,
           LAG(id)  OVER (ORDER BY sort_key) AS prev_id,
           LEAD(id) OVER (ORDER BY sort_key) AS next_id
         FROM script WHERE production_id = $1
       )
       SELECT id, prev_id, next_id FROM ordered WHERE id = ANY($2::text[])`,
      [productionId, deleteBlockIds]
    );
    for (const r of res.rows) blockAdj.set(r.id, { prevId: r.prev_id, nextId: r.next_id });
  }

  // ── Phase 2: main script transaction ─────────────────────────────────────
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (upsertScenes.length > 0) {
      await client.query(
        `INSERT INTO scene (id, production_id, num, name, sort_order, parent_id)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[]), unnest($5::int[]), unnest($6::text[])
         ON CONFLICT (id) DO UPDATE SET num = EXCLUDED.num, name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, parent_id = EXCLUDED.parent_id`,
        [upsertScenes.map(s => s.id), productionId,
         upsertScenes.map(s => s.number), upsertScenes.map(s => s.name), upsertScenes.map(s => s.sortOrder),
         upsertScenes.map(s => s.parentId ?? null)]
      );
    }

    if (upsertChars.length > 0) {
      await client.query(
        `INSERT INTO character (id, production_id, name, sort_order, is_aggregate)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[]), unnest($5::bool[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, is_aggregate = EXCLUDED.is_aggregate`,
        [upsertChars.map(c => c.id), productionId,
         upsertChars.map(c => c.name), upsertChars.map(c => c.sortOrder),
         upsertChars.map(c => c.isAggregate)]
      );
    }

    if (upsertBlocks.length > 0) {
      await client.query(
        `INSERT INTO script (id, production_id, sort_key, scene_id, rehearsal_mark, type, content)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[]),
                unnest($5::text[]), unnest($6::block_type[]), unnest($7::text[])
         ON CONFLICT (id) DO UPDATE SET
           sort_key = EXCLUDED.sort_key, scene_id = EXCLUDED.scene_id,
           rehearsal_mark = EXCLUDED.rehearsal_mark, type = EXCLUDED.type, content = EXCLUDED.content`,
        [
          upsertBlocks.map(b => b.id), productionId,
          upsertBlocks.map(b => b.lexKey), upsertBlocks.map(b => b.sceneId ?? null),
          upsertBlocks.map(b => b.rehearsalMark ?? null), upsertBlocks.map(b => toDbType(b)),
          upsertBlocks.map(b => b.content),
        ]
      );

      // Replace character associations for all upserted blocks
      await client.query(
        "DELETE FROM script_character WHERE script_id = ANY($1::text[])",
        [upsertBlocks.map(b => b.id)]
      );
      const scRows = upsertBlocks.flatMap(b =>
        b.characterIds.map((cid, pos) => ({ sid: b.id, cid, pos, ann: b.characterAnnotations[cid] ?? null }))
      );
      if (scRows.length > 0) {
        await client.query(
          `INSERT INTO script_character (script_id, character_id, position, annotation)
           SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), unnest($4::text[])`,
          [scRows.map(r => r.sid), scRows.map(r => r.cid), scRows.map(r => r.pos), scRows.map(r => r.ann)]
        );
      }
    }

    if (deleteBlockIds.length > 0)
      await client.query("DELETE FROM script WHERE id = ANY($1::text[])", [deleteBlockIds]);
    if (deleteCharIds.length > 0)
      await client.query("DELETE FROM character WHERE id = ANY($1::text[])", [deleteCharIds]);
    if (deleteSceneIds.length > 0)
      await client.query("DELETE FROM scene WHERE id = ANY($1::text[])", [deleteSceneIds]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // ── Phase 3: cue drift adjustments (best-effort, after script committed) ──
  const driftJobs: Promise<void>[] = [];
  for (const blockId of deleteBlockIds) {
    const adj = blockAdj.get(blockId);
    if (adj) driftJobs.push(handleBlockDeleted(blockId, adj.prevId, adj.nextId));
  }
  for (const block of upsertBlocks) {
    const old = oldContents.get(block.id);
    if (old !== undefined && old !== block.content)
      driftJobs.push(handleBlockContentChanged(block.id, old, block.content));
  }
  if (driftJobs.length > 0) await Promise.allSettled(driftJobs);
}

// ─── Production management ────────────────────────────────────────────────────

export async function createProduction(id: string, name: string): Promise<void> {
  await getPool().query("INSERT INTO production (id, name) VALUES ($1, $2)", [id, name]);
}

export async function deleteProduction(id: string): Promise<void> {
  await getPool().query("DELETE FROM production WHERE id = $1", [id]);
}

export async function listProductions(opts: { openId: string; isAdmin: boolean }): Promise<{ id: string; name: string; createdAt: string; archivedAt: string | null }[]> {
  let res;
  if (opts.isAdmin) {
    res = await getPool().query<{ id: string; name: string; created_at: Date; archived_at: Date | null }>(
      "SELECT id, name, created_at, archived_at FROM production ORDER BY created_at DESC"
    );
  } else {
    res = await getPool().query<{ id: string; name: string; created_at: Date; archived_at: Date | null }>(
      `SELECT p.id, p.name, p.created_at, p.archived_at FROM production p
       JOIN production_member pm ON pm.production_id = p.id
       WHERE pm.open_id = $1 ORDER BY p.created_at DESC`,
      [opts.openId]
    );
  }
  return res.rows.map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
  }));
}

// ─── Auth / users ─────────────────────────────────────────────────────────────

export type UserInfo = { openId: string; name: string; avatarUrl: string | null; isAdmin: boolean };

export async function upsertFeishuUser(openId: string, name: string, avatarUrl: string | null, isAdmin: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO feishu_user (open_id, name, avatar_url, is_super_admin, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (open_id) DO UPDATE
       SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, is_super_admin = EXCLUDED.is_super_admin, updated_at = now()`,
    [openId, name, avatarUrl, isAdmin]
  );
}

export async function getFeishuUser(openId: string): Promise<UserInfo | null> {
  const res = await getPool().query<{ open_id: string; name: string; avatar_url: string | null; is_super_admin: boolean }>(
    "SELECT open_id, name, avatar_url, is_super_admin FROM feishu_user WHERE open_id = $1",
    [openId]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return { openId: r.open_id, name: r.name, avatarUrl: r.avatar_url, isAdmin: r.is_super_admin };
}

export async function listAllUsers(): Promise<UserInfo[]> {
  const res = await getPool().query<{ open_id: string; name: string; avatar_url: string | null; is_super_admin: boolean }>(
    "SELECT open_id, name, avatar_url, is_super_admin FROM feishu_user ORDER BY name"
  );
  return res.rows.map(r => ({ openId: r.open_id, name: r.name, avatarUrl: r.avatar_url, isAdmin: r.is_super_admin }));
}

export async function canUserAccessProduction(openId: string, productionId: string): Promise<boolean> {
  const res = await getPool().query<{ count: string }>(
    "SELECT count(*)::text FROM production_member WHERE open_id = $1 AND production_id = $2",
    [openId, productionId]
  );
  return parseInt(res.rows[0].count) > 0;
}

/** Returns the user's roles in the production, or null if they are not a member. */
export async function getProductionMemberRoles(
  openId: string,
  productionId: string,
): Promise<string[] | null> {
  const res = await getPool().query<{ roles: string[] }>(
    "SELECT roles FROM production_member WHERE open_id = $1 AND production_id = $2",
    [openId, productionId],
  );
  return res.rows.length ? res.rows[0].roles : null;
}

export async function getPermissionOverrides(
  productionId: string,
  openId: string,
): Promise<PermissionOverrides> {
  const res = await getPool().query<{ permission: string; granted: boolean }>(
    "SELECT permission, granted FROM production_member_permission WHERE production_id = $1 AND open_id = $2",
    [productionId, openId],
  );
  const map: PermissionOverrides = new Map();
  for (const row of res.rows) map.set(row.permission as Permission, row.granted);
  return map;
}

export async function setPermissionOverride(
  productionId: string,
  openId: string,
  permission: Permission,
  granted: boolean | null,
): Promise<void> {
  if (granted === null) {
    await getPool().query(
      "DELETE FROM production_member_permission WHERE production_id = $1 AND open_id = $2 AND permission = $3",
      [productionId, openId, permission],
    );
  } else {
    await getPool().query(
      `INSERT INTO production_member_permission (production_id, open_id, permission, granted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (production_id, open_id, permission) DO UPDATE SET granted = EXCLUDED.granted`,
      [productionId, openId, permission, granted],
    );
  }
}

/** Bulk-load all overrides for all members in a production (for the management UI). */
export async function getAllPermissionOverrides(
  productionId: string,
): Promise<Record<string, Record<string, boolean>>> {
  const res = await getPool().query<{ open_id: string; permission: string; granted: boolean }>(
    "SELECT open_id, permission, granted FROM production_member_permission WHERE production_id = $1",
    [productionId],
  );
  const result: Record<string, Record<string, boolean>> = {};
  for (const row of res.rows) {
    result[row.open_id] ??= {};
    result[row.open_id][row.permission] = row.granted;
  }
  return result;
}

/** Fetch roles + overrides + archived status for a single user in parallel. */
export async function getProductionMemberContext(
  openId: string,
  isAdmin: boolean,
  productionId: string,
): Promise<{ memberRoles: string[] | null; overrides: PermissionOverrides; isArchived: boolean }> {
  const [memberRoles, overrides, archivedRow] = await Promise.all([
    getProductionMemberRoles(openId, productionId),
    getPermissionOverrides(productionId, openId),
    getPool().query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM production WHERE id = $1",
      [productionId],
    ),
  ]);
  void isAdmin;
  return { memberRoles, overrides, isArchived: archivedRow.rows[0]?.archived_at != null };
}

export async function isProductionArchived(productionId: string): Promise<boolean> {
  const res = await getPool().query<{ archived_at: Date | null }>(
    "SELECT archived_at FROM production WHERE id = $1",
    [productionId],
  );
  return res.rows[0]?.archived_at != null;
}

export async function archiveProduction(id: string): Promise<void> {
  await getPool().query(
    "UPDATE production SET archived_at = NOW() WHERE id = $1",
    [id],
  );
}

export async function unarchiveProduction(id: string): Promise<void> {
  await getPool().query(
    "UPDATE production SET archived_at = NULL WHERE id = $1",
    [id],
  );
}

export async function listProductionMembers(productionId: string): Promise<UserInfo[]> {
  const res = await getPool().query<{ open_id: string; name: string; avatar_url: string | null; is_super_admin: boolean }>(
    `SELECT fu.open_id, fu.name, fu.avatar_url, fu.is_super_admin
     FROM production_member pm JOIN feishu_user fu ON fu.open_id = pm.open_id
     WHERE pm.production_id = $1 ORDER BY fu.name`,
    [productionId]
  );
  return res.rows.map(r => ({ openId: r.open_id, name: r.name, avatarUrl: r.avatar_url, isAdmin: r.is_super_admin }));
}

export async function addProductionMember(productionId: string, openId: string): Promise<void> {
  await getPool().query(
    "INSERT INTO production_member (production_id, open_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [productionId, openId]
  );
}

export async function removeProductionMember(productionId: string, openId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM production_member WHERE production_id = $1 AND open_id = $2",
    [productionId, openId]
  );
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export type Mention = { openId: string; name: string };

export type Comment = {
  id: string;
  productionId: string;
  contextType: string;
  contextId: string;
  parentId: string | null;
  openId: string;
  authorName: string;
  body: string;
  mentions: Mention[];
  createdAt: string;
  updatedAt: string;
};

type CommentRow = {
  id: string;
  production_id: string;
  context_type: string;
  context_id: string;
  parent_id: string | null;
  open_id: string;
  author_name: string;
  body: string;
  mentions: Mention[];
  created_at: Date;
  updated_at: Date;
};

function rowToComment(r: CommentRow): Comment {
  return {
    id: r.id,
    productionId: r.production_id,
    contextType: r.context_type,
    contextId: r.context_id,
    parentId: r.parent_id,
    openId: r.open_id,
    authorName: r.author_name,
    body: r.body,
    mentions: r.mentions ?? [],
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listProductionComments(productionId: string): Promise<Comment[]> {
  const res = await getPool().query<CommentRow>(
    `SELECT id, production_id, context_type, context_id, parent_id,
            open_id, author_name, body, mentions, created_at, updated_at
     FROM comment WHERE production_id = $1 ORDER BY created_at ASC`,
    [productionId]
  );
  return res.rows.map(rowToComment);
}

export async function createComment(
  productionId: string,
  contextType: string,
  contextId: string,
  parentId: string | null,
  openId: string,
  authorName: string,
  body: string,
  mentions: Mention[],
): Promise<Comment> {
  const res = await getPool().query<CommentRow>(
    `INSERT INTO comment
       (production_id, context_type, context_id, parent_id, open_id, author_name, body, mentions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, production_id, context_type, context_id, parent_id,
               open_id, author_name, body, mentions, created_at, updated_at`,
    [productionId, contextType, contextId, parentId, openId, authorName, body, JSON.stringify(mentions)]
  );
  return rowToComment(res.rows[0]);
}

export async function getCommentById(id: string): Promise<Comment | null> {
  const res = await getPool().query<CommentRow>(
    `SELECT id, production_id, context_type, context_id, parent_id,
            open_id, author_name, body, mentions, created_at, updated_at
     FROM comment WHERE id = $1`,
    [id]
  );
  return res.rows.length ? rowToComment(res.rows[0]) : null;
}

export async function updateComment(id: string, openId: string, body: string): Promise<Comment | null> {
  const res = await getPool().query<CommentRow>(
    `UPDATE comment SET body = $1, updated_at = now()
     WHERE id = $2 AND open_id = $3
     RETURNING id, production_id, context_type, context_id, parent_id,
               open_id, author_name, body, mentions, created_at, updated_at`,
    [body, id, openId]
  );
  return res.rows.length ? rowToComment(res.rows[0]) : null;
}

export async function deleteComment(id: string, openId: string, isAdmin: boolean): Promise<boolean> {
  const res = isAdmin
    ? await getPool().query("DELETE FROM comment WHERE id = $1 RETURNING id", [id])
    : await getPool().query("DELETE FROM comment WHERE id = $1 AND open_id = $2 RETURNING id", [id, openId]);
  return res.rows.length > 0;
}

// ─── Production detail ────────────────────────────────────────────────────────

export async function getProductionName(id: string): Promise<string | null> {
  const res = await getPool().query<{ name: string }>(
    "SELECT name FROM production WHERE id = $1",
    [id]
  );
  return res.rows[0]?.name ?? null;
}

export type MemberWithRoles = {
  openId: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  email: string | null;
  phone: string | null;
  roles: string[];
  photoUrl: string | null;
};

export async function listProductionMembersWithRoles(productionId: string): Promise<MemberWithRoles[]> {
  const res = await getPool().query<{
    open_id: string; name: string; avatar_url: string | null; is_super_admin: boolean;
    email: string | null; phone: string | null; roles: string[]; photo_url: string | null;
  }>(
    `SELECT fu.open_id, fu.name, fu.avatar_url, fu.is_super_admin,
            fu.email, fu.phone, pm.roles, pm.photo_url
     FROM production_member pm
     JOIN feishu_user fu ON fu.open_id = pm.open_id
     WHERE pm.production_id = $1
     ORDER BY fu.name`,
    [productionId]
  );
  return res.rows.map((r) => ({
    openId: r.open_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    isAdmin: r.is_super_admin,
    email: r.email,
    phone: r.phone,
    roles: r.roles,
    photoUrl: r.photo_url,
  }));
}

/** Returns open IDs of all 制作人 and 制作助理 in a production (auto-added to dept chats). */
export async function getBossOpenIds(productionId: string): Promise<string[]> {
  const res = await getPool().query<{ open_id: string }>(
    `SELECT open_id FROM production_member
     WHERE production_id = $1
       AND ('制作人' = ANY(roles) OR '制作助理' = ANY(roles))`,
    [productionId]
  );
  return res.rows.map(r => r.open_id);
}

// ─── Contact import ───────────────────────────────────────────────────────────

export async function findUserByName(name: string): Promise<{ openId: string } | null> {
  const res = await getPool().query<{ open_id: string }>(
    "SELECT open_id FROM feishu_user WHERE name = $1 LIMIT 1",
    [name]
  );
  return res.rows[0] ? { openId: res.rows[0].open_id } : null;
}

// Writes a user sourced from the contact sheet. Email/phone only overwrite if non-null.
export async function upsertContactUser(
  openId: string,
  name: string,
  avatarUrl: string | null,
  email: string | null,
  phone: string | null
): Promise<void> {
  await getPool().query(
    `INSERT INTO feishu_user (open_id, name, avatar_url, email, phone, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (open_id) DO UPDATE
       SET name       = EXCLUDED.name,
           avatar_url = COALESCE(EXCLUDED.avatar_url, feishu_user.avatar_url),
           email      = COALESCE(EXCLUDED.email,      feishu_user.email),
           phone      = COALESCE(EXCLUDED.phone,      feishu_user.phone),
           updated_at = now()`,
    [openId, name, avatarUrl, email, phone]
  );
}

export type CharacterDetail = Character & {
  gender: string;
  biography: string;
  roleType: string;
  memberIds: string[]; // IDs of constituent characters (only non-empty for aggregate)
};

// Upserts a production member with roles and an optional production-specific photo.
// Photo only overwrites if a new value is provided.
export async function listProductionCharacters(productionId: string): Promise<CharacterDetail[]> {
  const pool = getPool();
  const [charsRes, membersRes] = await Promise.all([
    pool.query<{
      id: string; name: string; is_aggregate: boolean;
      gender: string | null; biography: string | null; role_type: string | null;
    }>(
      "SELECT id, name, is_aggregate, gender, biography, role_type FROM character WHERE production_id = $1 ORDER BY sort_order, name",
      [productionId]
    ),
    pool.query<{ aggregate_id: string; member_id: string }>(
      `SELECT ca.aggregate_id, ca.member_id FROM character_aggregate ca
       JOIN character c ON c.id = ca.aggregate_id WHERE c.production_id = $1`,
      [productionId]
    ),
  ]);
  const memberMap = new Map<string, string[]>();
  for (const row of membersRes.rows) {
    if (!memberMap.has(row.aggregate_id)) memberMap.set(row.aggregate_id, []);
    memberMap.get(row.aggregate_id)!.push(row.member_id);
  }
  return charsRes.rows.map((r) => ({
    id: r.id, name: r.name, isAggregate: r.is_aggregate,
    gender: r.gender ?? "",
    biography: r.biography ?? "",
    roleType: r.role_type ?? "",
    memberIds: memberMap.get(r.id) ?? [],
  }));
}

export async function setCharacterMembers(aggregateId: string, memberIds: string[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM character_aggregate WHERE aggregate_id = $1", [aggregateId]);
    if (memberIds.length > 0) {
      await client.query(
        `INSERT INTO character_aggregate (aggregate_id, member_id)
         SELECT $1::text, unnest($2::text[])`,
        [aggregateId, memberIds]
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

export async function patchCharacterMeta(
  id: string,
  fields: { gender?: string; biography?: string; roleType?: string }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.gender   !== undefined) { sets.push(`gender = $${vals.push(fields.gender)}`); }
  if (fields.biography !== undefined) { sets.push(`biography = $${vals.push(fields.biography)}`); }
  if (fields.roleType  !== undefined) { sets.push(`role_type = $${vals.push(fields.roleType)}`); }
  if (!sets.length) return;
  vals.push(id);
  await getPool().query(`UPDATE character SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

/** Returns ordered rehearsal marks grouped by scene_id. */
export async function listRehearsalMarksByScene(productionId: string): Promise<Record<string, string[]>> {
  const res = await getPool().query<{ scene_id: string; rehearsal_mark: string }>(
    `SELECT scene_id, rehearsal_mark
     FROM script
     WHERE production_id = $1 AND scene_id IS NOT NULL AND rehearsal_mark IS NOT NULL
     ORDER BY sort_key`,
    [productionId]
  );
  const map: Record<string, string[]> = {};
  for (const row of res.rows) {
    if (!map[row.scene_id]) map[row.scene_id] = [];
    const arr = map[row.scene_id];
    if (arr[arr.length - 1] !== row.rehearsal_mark) arr.push(row.rehearsal_mark);
  }
  return map;
}

export async function listProductionScenes(productionId: string): Promise<SceneDetail[]> {
  const res = await getPool().query<{
    id: string; num: string; name: string; parent_id: string | null;
    synopsis: string | null; action_line: string | null; music: string | null;
    stage_notes: string | null; expected_duration: string | null;
  }>(
    "SELECT id, num, name, parent_id, synopsis, action_line, music, stage_notes, expected_duration FROM scene WHERE production_id = $1 ORDER BY sort_order",
    [productionId]
  );
  return res.rows.map((r) => ({
    id: r.id, number: r.num, name: r.name, parentId: r.parent_id,
    synopsis: r.synopsis ?? "",
    actionLine: r.action_line ?? "",
    music: r.music ?? "",
    stageNotes: r.stage_notes ?? "",
    expectedDuration: r.expected_duration ?? "",
  }));
}

export async function getCharacterById(id: string, productionId: string): Promise<CharacterDetail | null> {
  const pool = getPool();
  const [charRes, membersRes] = await Promise.all([
    pool.query<{
      id: string; name: string; is_aggregate: boolean;
      gender: string | null; biography: string | null; role_type: string | null;
    }>(
      "SELECT id, name, is_aggregate, gender, biography, role_type FROM character WHERE id = $1 AND production_id = $2",
      [id, productionId]
    ),
    pool.query<{ member_id: string }>(
      "SELECT member_id FROM character_aggregate WHERE aggregate_id = $1",
      [id]
    ),
  ]);
  const r = charRes.rows[0];
  return r ? {
    id: r.id, name: r.name, isAggregate: r.is_aggregate,
    gender: r.gender ?? "", biography: r.biography ?? "", roleType: r.role_type ?? "",
    memberIds: membersRes.rows.map((m) => m.member_id),
  } : null;
}

export type SceneDetail = Scene & {
  synopsis: string;
  actionLine: string;
  music: string;
  stageNotes: string;
  expectedDuration: string;
};

export async function getSceneById(id: string, productionId: string): Promise<SceneDetail | null> {
  const res = await getPool().query<{
    id: string; num: string; name: string; parent_id: string | null;
    synopsis: string | null; action_line: string | null; music: string | null;
    stage_notes: string | null; expected_duration: string | null;
  }>(
    "SELECT id, num, name, parent_id, synopsis, action_line, music, stage_notes, expected_duration FROM scene WHERE id = $1 AND production_id = $2",
    [id, productionId]
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return {
    id: r.id, number: r.num, name: r.name, parentId: r.parent_id,
    synopsis: r.synopsis ?? "",
    actionLine: r.action_line ?? "",
    music: r.music ?? "",
    stageNotes: r.stage_notes ?? "",
    expectedDuration: r.expected_duration ?? "",
  };
}

export async function updateSceneMetadata(
  id: string,
  productionId: string,
  fields: Partial<Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">>
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [id, productionId];
  const map: Record<string, string> = {
    synopsis: "synopsis", actionLine: "action_line", music: "music",
    stageNotes: "stage_notes", expectedDuration: "expected_duration",
  };
  for (const [key, col] of Object.entries(map)) {
    if (key in fields) {
      values.push(fields[key as keyof typeof fields] ?? "");
      sets.push(`${col} = $${values.length}`);
    }
  }
  if (sets.length === 0) return;
  await getPool().query(
    `UPDATE scene SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2`,
    values
  );
}

// ─── Cue lists ────────────────────────────────────────────────────────────────

import type { CueList, CueListPermissionRow } from "./cue-list-types";

type CueListRow = {
  id: string; production_id: string; name: string; notes: string;
  template: string | null; default_edit_roles: string[];
  created_by: string; created_by_name: string; created_at: Date;
};

export async function listCueLists(productionId: string): Promise<CueList[]> {
  const res = await getPool().query<CueListRow>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.template,
            cl.default_edit_roles, cl.created_by, fu.name AS created_by_name, cl.created_at
     FROM cue_list cl
     JOIN feishu_user fu ON fu.open_id = cl.created_by
     WHERE cl.production_id = $1
     ORDER BY cl.created_at`,
    [productionId]
  );
  return res.rows.map(r => ({
    id: r.id, productionId: r.production_id, name: r.name, notes: r.notes,
    template: r.template, defaultEditRoles: r.default_edit_roles,
    createdBy: r.created_by, createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function createCueList(data: {
  id: string; productionId: string; name: string; notes: string;
  template: string | null; defaultEditRoles: string[]; createdBy: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO cue_list (id, production_id, name, notes, template, default_edit_roles, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [data.id, data.productionId, data.name, data.notes, data.template, data.defaultEditRoles, data.createdBy]
  );
}

export async function getCueList(id: string, productionId: string): Promise<CueList | null> {
  const res = await getPool().query<CueListRow>(
    `SELECT cl.id, cl.production_id, cl.name, cl.notes, cl.template,
            cl.default_edit_roles, cl.created_by, fu.name AS created_by_name, cl.created_at
     FROM cue_list cl
     JOIN feishu_user fu ON fu.open_id = cl.created_by
     WHERE cl.id = $1 AND cl.production_id = $2`,
    [id, productionId]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    id: r.id, productionId: r.production_id, name: r.name, notes: r.notes,
    template: r.template, defaultEditRoles: r.default_edit_roles,
    createdBy: r.created_by, createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
  };
}

export async function updateCueList(
  id: string, productionId: string,
  fields: { name?: string; notes?: string }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id, productionId];
  if (fields.name  !== undefined) sets.push(`name  = $${vals.push(fields.name)}`);
  if (fields.notes !== undefined) sets.push(`notes = $${vals.push(fields.notes)}`);
  if (!sets.length) return;
  await getPool().query(
    `UPDATE cue_list SET ${sets.join(", ")} WHERE id = $1 AND production_id = $2`,
    vals
  );
}

export async function deleteCueList(id: string, productionId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM cue_list WHERE id = $1 AND production_id = $2",
    [id, productionId]
  );
}

export async function listCueListPermissions(cueListId: string): Promise<CueListPermissionRow[]> {
  const res = await getPool().query<{ open_id: string; can_edit: boolean }>(
    "SELECT open_id, can_edit FROM cue_list_permission WHERE cue_list_id = $1",
    [cueListId]
  );
  return res.rows.map(r => ({ openId: r.open_id, canEdit: r.can_edit }));
}

export async function setCueListPermission(
  cueListId: string, openId: string, canEdit: boolean | null
): Promise<void> {
  if (canEdit === null) {
    await getPool().query(
      "DELETE FROM cue_list_permission WHERE cue_list_id = $1 AND open_id = $2",
      [cueListId, openId]
    );
  } else {
    await getPool().query(
      `INSERT INTO cue_list_permission (cue_list_id, open_id, can_edit) VALUES ($1, $2, $3)
       ON CONFLICT (cue_list_id, open_id) DO UPDATE SET can_edit = EXCLUDED.can_edit`,
      [cueListId, openId, canEdit]
    );
  }
}

// ─── Cues ─────────────────────────────────────────────────────────────────────

type CueRow = {
  id: string; cue_list_id: string; number: string; name: string; content: string;
  start_kind: string; start_block_id: string; start_offset: number | null;
  end_kind: string;   end_block_id: string;   end_offset: number | null;
  warning: boolean;
};

function rowToCue(r: CueRow): Cue {
  const start: CueAnchor = r.start_kind === "gap"
    ? { kind: "gap", afterBlockId: r.start_block_id }
    : { kind: "block", blockId: r.start_block_id, offset: r.start_offset! };
  const end: CueAnchor = r.end_kind === "gap"
    ? { kind: "gap", afterBlockId: r.end_block_id }
    : { kind: "block", blockId: r.end_block_id, offset: r.end_offset! };
  return { id: r.id, cueListId: r.cue_list_id, number: r.number, name: r.name, content: r.content, start, end, warning: r.warning };
}

function anchorToDb(a: CueAnchor) {
  if (a.kind === "gap") return { kind: "gap", blockId: a.afterBlockId, offset: null };
  return { kind: "block", blockId: a.blockId, offset: a.offset };
}

export async function listCues(cueListId: string): Promise<Cue[]> {
  const res = await getPool().query<CueRow>(
    `SELECT id, cue_list_id, number, name, content,
            start_kind, start_block_id, start_offset,
            end_kind, end_block_id, end_offset, warning
     FROM cue WHERE cue_list_id = $1 ORDER BY number`,
    [cueListId]
  );
  return res.rows.map(rowToCue);
}

export async function listCuesByProduction(productionId: string): Promise<Cue[]> {
  const res = await getPool().query<CueRow>(
    `SELECT c.id, c.cue_list_id, c.number, c.name, c.content,
            c.start_kind, c.start_block_id, c.start_offset,
            c.end_kind, c.end_block_id, c.end_offset, c.warning
     FROM cue c
     JOIN cue_list cl ON cl.id = c.cue_list_id
     WHERE cl.production_id = $1
     ORDER BY c.number`,
    [productionId]
  );
  return res.rows.map(rowToCue);
}

export async function countWarningCues(cueListIds: string[]): Promise<number> {
  if (cueListIds.length === 0) return 0;
  const res = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM cue WHERE cue_list_id = ANY($1::text[]) AND warning = TRUE`,
    [cueListIds]
  );
  return parseInt(res.rows[0].count, 10);
}

export async function createCue(data: {
  id: string; cueListId: string; number: string; name: string; content: string;
  start: CueAnchor; end: CueAnchor;
}): Promise<void> {
  const s = anchorToDb(data.start);
  const e = anchorToDb(data.end);
  await getPool().query(
    `INSERT INTO cue (id, cue_list_id, number, name, content,
       start_kind, start_block_id, start_offset,
       end_kind,   end_block_id,   end_offset)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [data.id, data.cueListId, data.number, data.name, data.content,
     s.kind, s.blockId, s.offset, e.kind, e.blockId, e.offset]
  );
}

export async function updateCue(
  id: string, cueListId: string,
  fields: { number?: string; name?: string; content?: string; start?: CueAnchor; end?: CueAnchor; warning?: boolean }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id, cueListId];
  if (fields.number  !== undefined) sets.push(`number  = $${vals.push(fields.number)}`);
  if (fields.name    !== undefined) sets.push(`name    = $${vals.push(fields.name)}`);
  if (fields.content !== undefined) sets.push(`content = $${vals.push(fields.content)}`);
  if (fields.warning !== undefined) sets.push(`warning = $${vals.push(fields.warning)}`);
  if (fields.start !== undefined) {
    const s = anchorToDb(fields.start);
    sets.push(`start_kind=$${vals.push(s.kind)}, start_block_id=$${vals.push(s.blockId)}, start_offset=$${vals.push(s.offset)}`);
  }
  if (fields.end !== undefined) {
    const e = anchorToDb(fields.end);
    sets.push(`end_kind=$${vals.push(e.kind)}, end_block_id=$${vals.push(e.blockId)}, end_offset=$${vals.push(e.offset)}`);
  }
  if (!sets.length) return;
  await getPool().query(
    `UPDATE cue SET ${sets.join(", ")} WHERE id = $1 AND cue_list_id = $2`,
    vals
  );
}

export async function deleteCue(id: string, cueListId: string): Promise<void> {
  await getPool().query("DELETE FROM cue WHERE id = $1 AND cue_list_id = $2", [id, cueListId]);
}

/**
 * Called when a block is deleted from the script.
 * Cues anchored to the deleted block are re-anchored:
 *   - If prevBlockId exists  → gap after prevBlockId
 *   - Else if nextBlockId exists → start of nextBlockId (offset 0)
 *   - Else → delete the cue (no script left)
 */
export async function handleBlockDeleted(
  deletedBlockId: string,
  prevBlockId: string | null,
  nextBlockId: string | null,
): Promise<void> {
  if (!prevBlockId && !nextBlockId) {
    await getPool().query(
      "DELETE FROM cue WHERE start_block_id = $1 OR end_block_id = $1",
      [deletedBlockId]
    );
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Replace start anchors; mark warning because position has shifted
    if (prevBlockId) {
      await client.query(
        `UPDATE cue SET start_kind='gap', start_block_id=$1, start_offset=NULL, warning=TRUE
         WHERE start_block_id = $2`,
        [prevBlockId, deletedBlockId]
      );
    } else {
      await client.query(
        `UPDATE cue SET start_kind='block', start_block_id=$1, start_offset=0, warning=TRUE
         WHERE start_block_id = $2`,
        [nextBlockId, deletedBlockId]
      );
    }
    // Replace end anchors; mark warning because position has shifted
    if (prevBlockId) {
      await client.query(
        `UPDATE cue SET end_kind='gap', end_block_id=$1, end_offset=NULL, warning=TRUE
         WHERE end_block_id = $2`,
        [prevBlockId, deletedBlockId]
      );
    } else {
      await client.query(
        `UPDATE cue SET end_kind='block', end_block_id=$1, end_offset=0, warning=TRUE
         WHERE end_block_id = $2`,
        [nextBlockId, deletedBlockId]
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

/**
 * Called when a block's text content changes.
 * Adjusts cue offsets that reference this block using the three-tier algorithm.
 */
export async function handleBlockContentChanged(
  blockId: string,
  oldContent: string,
  newContent: string,
): Promise<void> {
  if (oldContent === newContent) return;

  const res = await getPool().query<CueRow>(
    `SELECT id, cue_list_id, number, name, content,
            start_kind, start_block_id, start_offset,
            end_kind, end_block_id, end_offset, warning
     FROM cue
     WHERE (start_kind='block' AND start_block_id=$1)
        OR (end_kind='block' AND end_block_id=$1)`,
    [blockId]
  );
  if (!res.rows.length) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const row of res.rows) {
      const startInBlock = row.start_kind === "block" && row.start_block_id === blockId;
      const endInBlock   = row.end_kind   === "block" && row.end_block_id   === blockId;

      let newStartOffset = row.start_offset;
      let newEndOffset   = row.end_offset;
      let warn = row.warning;

      if (startInBlock && endInBlock) {
        // Same-block range or point cue — use full algorithm
        const result = adjustBlockAnchor(
          oldContent, newContent,
          row.start_offset!, row.end_offset!
        );
        newStartOffset = result.startOffset;
        newEndOffset   = result.endOffset;
        if (result.warning) warn = true;
      } else {
        // Cross-block cue: adjust just the endpoint that lives in this block
        if (startInBlock) {
          newStartOffset = lcsAdjust(oldContent, newContent, row.start_offset!);
        }
        if (endInBlock) {
          newEndOffset = lcsAdjust(oldContent, newContent, row.end_offset!);
        }
      }

      if (newStartOffset !== row.start_offset || newEndOffset !== row.end_offset || warn !== row.warning) {
        await client.query(
          `UPDATE cue SET start_offset=$1, end_offset=$2, warning=$3 WHERE id=$4`,
          [newStartOffset, newEndOffset, warn, row.id]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertProductionMemberWithRoles(
  productionId: string,
  openId: string,
  roles: string[],
  photoUrl: string | null
): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member (production_id, open_id, roles, photo_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (production_id, open_id) DO UPDATE
       SET roles     = EXCLUDED.roles,
           photo_url = EXCLUDED.photo_url`,
    [productionId, openId, roles, photoUrl]
  );
}
