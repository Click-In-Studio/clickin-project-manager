import { getPool } from "./pg";
import type { Block, Character, Scene, ScriptState } from "./script-types";

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
type SceneRow = { id: string; num: string; name: string; sort_order: number };
type CharRow  = { id: string; name: string; sort_order: number };
type ScCharRow = { script_id: string; character_id: string };

// ─── Read ─────────────────────────────────────────────────────────────────────

export type ProductionState = {
  state: ScriptState;
  sortKeys: Map<string, string>; // block_id → sort_key from DB
};

/** Load all data for a production. Returns null if the production doesn't exist. */
export async function loadProduction(productionId: string): Promise<ProductionState | null> {
  const pool = getPool();

  const [[blocksRes, scenesRes, charsRes], existsRes] = await Promise.all([
    Promise.all([
      pool.query<BlockRow>(
        "SELECT id, sort_key, scene_id, rehearsal_mark, type, content FROM script WHERE production_id = $1 ORDER BY sort_key",
        [productionId]
      ),
      pool.query<SceneRow>(
        "SELECT id, num, name, sort_order FROM scene WHERE production_id = $1 ORDER BY sort_order",
        [productionId]
      ),
      pool.query<CharRow>(
        "SELECT id, name, sort_order FROM character WHERE production_id = $1 ORDER BY sort_order",
        [productionId]
      ),
    ]),
    pool.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM production WHERE id = $1) AS exists",
      [productionId]
    ),
  ]);

  if (!existsRes.rows[0].exists) return null;

  const blockIds = blocksRes.rows.map(r => r.id);
  const scCharRes = blockIds.length > 0
    ? await pool.query<ScCharRow>(
        "SELECT script_id, character_id FROM script_character WHERE script_id = ANY($1::text[]) ORDER BY script_id, position",
        [blockIds]
      )
    : { rows: [] as ScCharRow[] };

  const charsByBlock = new Map<string, string[]>();
  for (const row of scCharRes.rows) {
    if (!charsByBlock.has(row.script_id)) charsByBlock.set(row.script_id, []);
    charsByBlock.get(row.script_id)!.push(row.character_id);
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
    };
  });

  return {
    state: {
      blocks,
      scenes: scenesRes.rows.map(r => ({ id: r.id, number: r.num, name: r.name })),
      characters: charsRes.rows.map(r => ({ id: r.id, name: r.name })),
    },
    sortKeys,
  };
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function flushToDB(productionId: string, payload: FlushPayload): Promise<void> {
  const { upsertBlocks, deleteBlockIds, upsertChars, deleteCharIds, upsertScenes, deleteSceneIds } = payload;
  if (!upsertBlocks.length && !deleteBlockIds.length && !upsertChars.length &&
      !deleteCharIds.length && !upsertScenes.length && !deleteSceneIds.length) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (upsertScenes.length > 0) {
      await client.query(
        `INSERT INTO scene (id, production_id, num, name, sort_order)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::text[]), unnest($5::int[])
         ON CONFLICT (id) DO UPDATE SET num = EXCLUDED.num, name = EXCLUDED.name, sort_order = EXCLUDED.sort_order`,
        [upsertScenes.map(s => s.id), productionId,
         upsertScenes.map(s => s.number), upsertScenes.map(s => s.name), upsertScenes.map(s => s.sortOrder)]
      );
    }

    if (upsertChars.length > 0) {
      await client.query(
        `INSERT INTO character (id, production_id, name, sort_order)
         SELECT unnest($1::text[]), $2::text, unnest($3::text[]), unnest($4::int[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order`,
        [upsertChars.map(c => c.id), productionId,
         upsertChars.map(c => c.name), upsertChars.map(c => c.sortOrder)]
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
        b.characterIds.map((cid, pos) => ({ sid: b.id, cid, pos }))
      );
      if (scRows.length > 0) {
        await client.query(
          `INSERT INTO script_character (script_id, character_id, position)
           SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::int[])`,
          [scRows.map(r => r.sid), scRows.map(r => r.cid), scRows.map(r => r.pos)]
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
}

// ─── Production management ────────────────────────────────────────────────────

export async function createProduction(id: string, name: string): Promise<void> {
  await getPool().query("INSERT INTO production (id, name) VALUES ($1, $2)", [id, name]);
}

export async function deleteProduction(id: string): Promise<void> {
  await getPool().query("DELETE FROM production WHERE id = $1", [id]);
}

export async function listProductions(opts: { openId: string; isAdmin: boolean }): Promise<{ id: string; name: string; createdAt: string }[]> {
  let res;
  if (opts.isAdmin) {
    res = await getPool().query<{ id: string; name: string; created_at: Date }>(
      "SELECT id, name, created_at FROM production ORDER BY created_at DESC"
    );
  } else {
    res = await getPool().query<{ id: string; name: string; created_at: Date }>(
      `SELECT p.id, p.name, p.created_at FROM production p
       JOIN production_member pm ON pm.production_id = p.id
       WHERE pm.open_id = $1 ORDER BY p.created_at DESC`,
      [opts.openId]
    );
  }
  return res.rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString() }));
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

export type Comment = {
  id: string;
  blockId: string;
  openId: string;
  authorName: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

type CommentRow = {
  id: string; block_id: string; open_id: string;
  author_name: string; content: string; created_at: Date; updated_at: Date;
};

function rowToComment(r: CommentRow): Comment {
  return {
    id: r.id,
    blockId: r.block_id,
    openId: r.open_id,
    authorName: r.author_name,
    content: r.content,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listProductionComments(productionId: string): Promise<Comment[]> {
  const res = await getPool().query<CommentRow>(
    `SELECT id, block_id, open_id, author_name, content, created_at, updated_at
     FROM block_comment WHERE production_id = $1 ORDER BY created_at ASC`,
    [productionId]
  );
  return res.rows.map(rowToComment);
}

export async function createComment(
  productionId: string, blockId: string, openId: string, authorName: string, content: string
): Promise<Comment> {
  const res = await getPool().query<CommentRow>(
    `INSERT INTO block_comment (production_id, block_id, open_id, author_name, content)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, block_id, open_id, author_name, content, created_at, updated_at`,
    [productionId, blockId, openId, authorName, content]
  );
  return rowToComment(res.rows[0]);
}

export async function updateComment(id: string, openId: string, content: string): Promise<Comment | null> {
  const res = await getPool().query<CommentRow>(
    `UPDATE block_comment SET content = $1, updated_at = now()
     WHERE id = $2 AND open_id = $3
     RETURNING id, block_id, open_id, author_name, content, created_at, updated_at`,
    [content, id, openId]
  );
  return res.rows.length ? rowToComment(res.rows[0]) : null;
}

export async function deleteComment(id: string, openId: string, isAdmin: boolean): Promise<boolean> {
  const res = isAdmin
    ? await getPool().query("DELETE FROM block_comment WHERE id = $1 RETURNING id", [id])
    : await getPool().query("DELETE FROM block_comment WHERE id = $1 AND open_id = $2 RETURNING id", [id, openId]);
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

// Upserts a production member with roles and an optional production-specific photo.
// Photo only overwrites if a new value is provided.
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
