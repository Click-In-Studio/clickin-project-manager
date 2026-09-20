/**
 * 项目公告（production_announcement / announcement_read）数据层。
 *
 * 项目内的 CRUD、跨项目「我的公告」列表、已读回执（谁读了 / 谁没读，供提醒接口点名）。
 * 通知投递不在这里——公告发布与提醒走 notify.ts，这里只管公告本体与已读记录。
 */
import { getPool } from "../pg";

export type ProductionAnnouncement = {
  id: string;
  productionId: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type AnnouncementRow = {
  id: string;
  production_id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

function mapAnnouncementRow(r: AnnouncementRow): ProductionAnnouncement {
  return {
    id: r.id,
    productionId: r.production_id,
    title: r.title,
    content: r.content,
    isPinned: r.is_pinned,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listAnnouncements(productionId: string): Promise<ProductionAnnouncement[]> {
  const res = await getPool().query<AnnouncementRow>(
    `SELECT id, production_id, title, content, is_pinned, created_by, created_at, updated_at
     FROM production_announcement WHERE production_id = $1 ORDER BY created_at DESC`,
    [productionId],
  );
  return res.rows.map(mapAnnouncementRow);
}

export async function createAnnouncement(
  id: string,
  productionId: string,
  title: string,
  content: string,
  createdBy: string,
): Promise<ProductionAnnouncement> {
  const res = await getPool().query<AnnouncementRow>(
    `INSERT INTO production_announcement (id, production_id, title, content, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, production_id, title, content, is_pinned, created_by, created_at, updated_at`,
    [id, productionId, title, content, createdBy],
  );
  return mapAnnouncementRow(res.rows[0]);
}

export async function getAnnouncement(id: string): Promise<ProductionAnnouncement | null> {
  const res = await getPool().query<AnnouncementRow>(
    `SELECT id, production_id, title, content, is_pinned, created_by, created_at, updated_at
     FROM production_announcement WHERE id = $1`,
    [id],
  );
  return res.rows[0] ? mapAnnouncementRow(res.rows[0]) : null;
}

export async function updateAnnouncement(
  id: string,
  productionId: string,
  fields: { title?: string; content?: string; isPinned?: boolean },
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (fields.isPinned === true) {
      await client.query(
        "UPDATE production_announcement SET is_pinned = false WHERE production_id = $1 AND is_pinned = true AND id != $2",
        [productionId, id],
      );
    }
    const sets: string[] = ["updated_at = now()"];
    const vals: unknown[] = [];
    if (fields.title !== undefined) { sets.push(`title = $${vals.push(fields.title)}`); }
    if (fields.content !== undefined) { sets.push(`content = $${vals.push(fields.content)}`); }
    if (fields.isPinned !== undefined) { sets.push(`is_pinned = $${vals.push(fields.isPinned)}`); }
    vals.push(id);
    await client.query(
      `UPDATE production_announcement SET ${sets.join(", ")} WHERE id = $${vals.length}`,
      vals,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await getPool().query("DELETE FROM production_announcement WHERE id = $1", [id]);
}

// ── Cross-project queries ─────────────────────────────────────────────────────

export type CrossProjectAnnouncement = {
  id: string;
  productionId: string;
  productionName: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdAt: string;
};

export async function listAnnouncementsForUser(
  userId: string,
  isAdmin: boolean,
): Promise<CrossProjectAnnouncement[]> {
  const res = await getPool().query<{
    id: string; production_id: string; production_name: string;
    title: string; content: string; is_pinned: boolean; created_at: Date;
  }>(
    `SELECT pa.id, pa.production_id, p.name AS production_name,
            pa.title, pa.content, pa.is_pinned, pa.created_at
     FROM production_announcement pa
     JOIN production p ON pa.production_id = p.id
     WHERE p.archived_at IS NULL
       AND ($1 OR EXISTS (
         SELECT 1 FROM production_member pm
         WHERE pm.production_id = pa.production_id AND pm.user_id = $2
           AND pm.status = 'active'
       ))
     ORDER BY pa.is_pinned DESC, pa.created_at DESC
     LIMIT 50`,
    [isAdmin, userId],
  );
  return res.rows.map(r => ({
    id: r.id,
    productionId: r.production_id,
    productionName: r.production_name,
    title: r.title,
    content: r.content,
    isPinned: r.is_pinned,
    createdAt: r.created_at.toISOString(),
  }));
}

// ── Announcement read tracking ────────────────────────────────────────────────

export async function markAnnouncementRead(announcementId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO announcement_read (announcement_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (announcement_id, user_id) DO NOTHING`,
    [announcementId, userId],
  );
}

export type AnnouncementReadMember = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  readAt: string | null;
};

export async function getAnnouncementReadStatus(
  announcementId: string,
  productionId: string,
): Promise<AnnouncementReadMember[]> {
  const res = await getPool().query<{
    user_id: string;
    name: string;
    avatar_url: string | null;
    read_at: Date | null;
  }>(
    `SELECT pm.user_id, COALESCE(up.name, '') AS name, up.avatar_url, ar.read_at
     FROM production_member pm
     LEFT JOIN user_profile up ON up.user_id = pm.user_id
     LEFT JOIN announcement_read ar
       ON ar.announcement_id = $1 AND ar.user_id = pm.user_id
     WHERE pm.production_id = $2 AND pm.status = 'active'
     ORDER BY ar.read_at NULLS LAST, up.name NULLS LAST`,
    [announcementId, productionId],
  );
  return res.rows.map(r => ({
    userId: r.user_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    readAt: r.read_at ? r.read_at.toISOString() : null,
  }));
}

export async function getUserAllReadAnnouncementIds(userId: string): Promise<string[]> {
  const res = await getPool().query<{ announcement_id: string }>(
    `SELECT announcement_id FROM announcement_read WHERE user_id = $1`,
    [userId],
  );
  return res.rows.map(r => r.announcement_id);
}

export async function getUserAnnouncementReadIds(
  productionId: string,
  userId: string,
): Promise<string[]> {
  const res = await getPool().query<{ announcement_id: string }>(
    `SELECT ar.announcement_id
     FROM announcement_read ar
     JOIN production_announcement pa ON pa.id = ar.announcement_id
     WHERE pa.production_id = $1 AND ar.user_id = $2`,
    [productionId, userId],
  );
  return res.rows.map(r => r.announcement_id);
}

export async function getUnreadMemberIds(
  announcementId: string,
  productionId: string,
): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT pm.user_id
     FROM production_member pm
     WHERE pm.production_id = $1 AND pm.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM announcement_read ar
         WHERE ar.announcement_id = $2 AND ar.user_id = pm.user_id
       )`,
    [productionId, announcementId],
  );
  return res.rows.map(r => r.user_id);
}
