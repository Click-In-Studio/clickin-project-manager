/**
 * 项目成员名册与档案（production_member 及其 tag / role 关联表）数据层。
 *
 * 入组写点 addProductionMember（复活也走这里，#141）、职位与照片、成员标签、直属上级、
 * 「制作人 / 制作助理」名单，以及两种名册读法（轻量 listProductionMembers / 带职位
 * 标签状态的 listProductionMembersWithRoles）。
 *
 * 不在这里：成员状态机（停用 / 退出 / 复职）的唯一写点是 member-status.ts；成员判定
 * 的唯一入口是 permission-context-db.ts 的 getProductionPermissionContext；部门归属
 * 在 dept-db.ts。supervisor_id 只做审批路由，不承载任何权限。
 */
import { getPool } from "../pg";
import { recomputeAndRevokeGrants } from "./dept-db";
import type { MemberStatus, MemberStatusSource } from "./member-status-shared";

export async function listProductionMembers(
  productionId: string,
): Promise<{ userId: string; name: string; avatarUrl: string | null; isAdmin: boolean }[]> {
  const res = await getPool().query<{ user_id: string; name: string | null; avatar_url: string | null; is_super_admin: boolean | null }>(
    `SELECT pm.user_id, up.name, up.avatar_url, fu.is_super_admin
     FROM production_member pm
     LEFT JOIN user_profile up ON up.user_id = pm.user_id
     LEFT JOIN feishu_user fu ON fu.user_id = pm.user_id
     WHERE pm.production_id = $1 AND pm.status <> 'exited'
     ORDER BY up.name NULLS LAST`,
    [productionId],
  );
  return res.rows.map(r => ({ userId: r.user_id, name: r.name ?? "", avatarUrl: r.avatar_url, isAdmin: r.is_super_admin ?? false }));
}

/**
 * 入组写点（邀请接受 / 直接加人都走这里）。
 *
 * ON CONFLICT 必须 DO UPDATE 而不是 DO NOTHING（#141）：退出后成员行是**留着**的
 * （status='exited'/'suspended'，署名与历史要能追溯）。DO NOTHING 会让「重新邀请
 * 一个退出过的人」变成一条静默空操作——行还在，status 还是 exited，人永远进不来，
 * 而界面显示邀请已接受。
 *
 * 复活即回到 active 并清空成因；旧授权不在这里恢复：exited 的授权在确认离组时已
 * 真撤（回来是新 membership），suspended 的授权本就冻着、复活即原样生效（复职零
 * 重配）。两种情形都不需要这里做任何授权动作。
 */
export async function addProductionMember(productionId: string, userId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: before } = await client.query<{ status: string }>(
      `SELECT status FROM production_member
        WHERE production_id = $1 AND user_id = $2 FOR UPDATE`,
      [productionId, userId],
    );
    const fromStatus = before[0]?.status ?? null;

    await client.query(
      `INSERT INTO production_member (production_id, user_id) VALUES ($1, $2)
       ON CONFLICT (production_id, user_id) DO UPDATE
          SET status = 'active', status_source = NULL,
              status_changed_at = NOW(), status_changed_by = NULL`,
      [productionId, userId],
    );

    // 只有真的复活了才留痕；首次入组与对 active 行的重复调用都不写审计行。
    if (fromStatus && fromStatus !== "active") {
      await client.query(
        `INSERT INTO production_member_status_audit
           (production_id, user_id, action, from_status, to_status, actor_id, note)
         VALUES ($1, $2, 'restore', $3, 'active', NULL, '重新入组')`,
        [productionId, userId, fromStatus],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// removeProductionMember 已删（#141）：成员行不可删除。
//
// 它此前撤权 + 删行，定位是「误加入」。但审计上删行就是抹痕迹，而「谁在什么时候被
// 谁从剧组里拿掉」正是最该留下的一条；留着这个函数，就等于留着一把抹痕迹的刀。
// 唯一的移出路径是 lib/perm/member-status.ts 的 suspend → confirmMemberExit：撤销授权、
// 保留成员行与完整轨迹。

export async function setMemberRoles(
  productionId: string,
  userId: string,
  roles: string[],
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Keep TEXT[] in sync for backward compat (dropped in Phase 3)
    await client.query(
      "UPDATE production_member SET roles = $3 WHERE production_id = $1 AND user_id = $2",
      [productionId, userId, roles],
    );

    // Rebuild production_member_role FK rows
    await client.query(
      "DELETE FROM production_member_role WHERE production_id = $1 AND user_id = $2",
      [productionId, userId],
    );
    if (roles.length > 0) {
      await client.query(
        `INSERT INTO production_member_role (production_id, user_id, role_id)
         SELECT $1, $2, pr.id
         FROM production_role pr
         WHERE pr.production_id = $1 AND pr.name = ANY($3::text[])
         ON CONFLICT DO NOTHING`,
        [productionId, userId, roles],
      );
    }

    // Cascade-revoke self_confirmed grants no longer covered by new roles or dept zone.
    await recomputeAndRevokeGrants(userId, productionId, "role_change", client);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function setMemberPhoto(
  productionId: string,
  userId: string,
  photoUrl: string | null,
): Promise<void> {
  await getPool().query(
    "UPDATE production_member SET photo_url = $3 WHERE production_id = $1 AND user_id = $2",
    [productionId, userId, photoUrl],
  );
}

export type MemberWithRoles = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  email: string | null;
  phone: string | null;
  roles: string[];
  tags: string[];
  photoUrl: string | null;
  supervisorId: string | null;
  supervisorName: string | null;
  status: MemberStatus;
  /** 非 active 时的成因：self=自助退出，admin=人事停用 */
  statusSource: MemberStatusSource | null;
  statusChangedAt: Date | null;
};

/**
 * 名册。默认不含已离组的人（exited）——他们不在剧组了，但行留着，历史可查。
 * includeExited 供组织页的「显示已离组」用。suspended 始终在册并带成因，
 * 因为「谁停用着、等谁处置」正是名册要回答的问题。
 */
export async function listProductionMembersWithRoles(
  productionId: string,
  opts: { includeExited?: boolean } = {},
): Promise<MemberWithRoles[]> {
  const res = await getPool().query<{
    user_id: string; name: string | null; avatar_url: string | null; is_super_admin: boolean | null;
    email: string | null; phone: string | null; roles: string[]; tags: string[]; photo_url: string | null;
    supervisor_id: string | null; supervisor_name: string | null; status: string;
    status_source: MemberStatusSource | null; status_changed_at: Date | null;
  }>(
    `SELECT pm.user_id, up.name, up.avatar_url, fu.is_super_admin,
            COALESCE(
              (SELECT upi.platform_user_id FROM user_platform_identity upi
               WHERE upi.user_id = pm.user_id AND upi.platform_id = 'email'
               ORDER BY upi.is_primary DESC, upi.created_at DESC LIMIT 1),
              fu.email
            ) AS email,
            COALESCE(up.phone, fu.phone) AS phone, pm.roles, pm.photo_url,
            pm.supervisor_id, sup.name AS supervisor_name,
            COALESCE(pm.status, 'active') AS status,
            pm.status_source, pm.status_changed_at,
            COALESCE(
              ARRAY(
                SELECT pmt.name
                FROM production_member_tag_assignment pmta
                JOIN production_member_tag pmt ON pmt.id = pmta.tag_id
                WHERE pmta.production_id = pm.production_id AND pmta.user_id = pm.user_id
                ORDER BY pmt.is_system DESC, pmt.name
              ),
              '{}'::text[]
            ) AS tags
     FROM production_member pm
     LEFT JOIN user_profile up ON up.user_id = pm.user_id
     LEFT JOIN feishu_user fu ON fu.user_id = pm.user_id
     LEFT JOIN user_profile sup ON sup.user_id = pm.supervisor_id
     WHERE pm.production_id = $1 AND ($2 OR pm.status <> 'exited')
     ORDER BY up.name NULLS LAST`,
    [productionId, opts.includeExited ?? false],
  );
  return res.rows.map((r) => ({
    userId: r.user_id,
    name: r.name ?? "",
    avatarUrl: r.avatar_url,
    isAdmin: r.is_super_admin ?? false,
    email: r.email,
    phone: r.phone,
    roles: r.roles,
    tags: r.tags,
    photoUrl: r.photo_url,
    supervisorId: r.supervisor_id,
    supervisorName: r.supervisor_name,
    status: r.status as MemberStatus,
    statusSource: r.status_source,
    statusChangedAt: r.status_changed_at,
  }));
}

// ── 成员标签 ─────────────────────────────────────────────────────────────────

export type MemberTag = {
  id: string;
  name: string;
  isSystem: boolean;
  productionId: string | null;
};

/** Lists all tags available in a production (system-wide + custom for this production). */
export async function listMemberTags(productionId: string): Promise<MemberTag[]> {
  const { rows } = await getPool().query<{
    id: string; name: string; is_system: boolean; production_id: string | null;
  }>(
    `SELECT id, name, is_system, production_id
     FROM production_member_tag
     WHERE production_id IS NULL OR production_id = $1
     ORDER BY is_system DESC, name`,
    [productionId],
  );
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    isSystem: r.is_system,
    productionId: r.production_id,
  }));
}

/** Creates a custom tag for a production. Rejects system tag names. */
export async function createMemberTag(
  productionId: string,
  name: string,
): Promise<MemberTag> {
  const existing = await getPool().query<{ id: string }>(
    "SELECT id FROM production_member_tag WHERE name = $1 AND production_id IS NULL",
    [name],
  );
  if (existing.rows.length > 0) {
    throw new Error("SYSTEM_TAG_NAME_CONFLICT");
  }
  const { rows } = await getPool().query<{
    id: string; name: string; is_system: boolean; production_id: string | null;
  }>(
    `INSERT INTO production_member_tag (production_id, name, is_system)
     VALUES ($1, $2, false)
     RETURNING id, name, is_system, production_id`,
    [productionId, name],
  );
  return {
    id: rows[0].id,
    name: rows[0].name,
    isSystem: rows[0].is_system,
    productionId: rows[0].production_id,
  };
}

/** Deletes a custom (non-system) tag. Cascades to tag assignments. */
export async function deleteMemberTag(tagId: string, productionId: string): Promise<void> {
  const { rows } = await getPool().query<{ is_system: boolean; production_id: string | null }>(
    "SELECT is_system, production_id FROM production_member_tag WHERE id = $1",
    [tagId],
  );
  if (rows.length === 0) throw new Error("TAG_NOT_FOUND");
  if (rows[0].is_system || rows[0].production_id !== productionId) {
    throw new Error("TAG_NOT_DELETABLE");
  }
  await getPool().query("DELETE FROM production_member_tag WHERE id = $1", [tagId]);
}

/** Gets all tag IDs assigned to a member in a production. */
export async function getMemberTagIds(productionId: string, userId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ tag_id: string }>(
    "SELECT tag_id FROM production_member_tag_assignment WHERE production_id = $1 AND user_id = $2",
    [productionId, userId],
  );
  return rows.map(r => r.tag_id);
}

/** Replaces all tag assignments for a member atomically. */
export async function setMemberTags(
  productionId: string,
  userId: string,
  tagIds: string[],
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM production_member_tag_assignment WHERE production_id = $1 AND user_id = $2",
      [productionId, userId],
    );
    if (tagIds.length > 0) {
      await client.query(
        `INSERT INTO production_member_tag_assignment (production_id, user_id, tag_id)
         SELECT $1, $2, t.id
         FROM unnest($3::uuid[]) AS t(id)
         JOIN production_member_tag pmt ON pmt.id = t.id
         WHERE pmt.production_id IS NULL OR pmt.production_id = $1
         ON CONFLICT DO NOTHING`,
        [productionId, userId, tagIds],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── 直属上级 / 制作人名单 ────────────────────────────────────────────────────

export async function setMemberSupervisor(
  productionId: string,
  userId: string,
  supervisorId: string | null,
): Promise<void> {
  await getPool().query(
    "UPDATE production_member SET supervisor_id = $3 WHERE production_id = $1 AND user_id = $2",
    [productionId, userId, supervisorId],
  );
}

// setMemberStatus 已退役（#141）：裸 UPDATE 不写审计、也分不清成因（自助退出还是
// 人事停用）。状态机的唯一写点是 lib/perm/member-status.ts，端点见
// app/api/production/[id]/members/[userId]/status/route.ts。

/** Returns Feishu open_ids of 制作人 / 制作助理 — used by Feishu bot to add them to dept chats. */
export async function getBossOpenIds(productionId: string): Promise<string[]> {
  const res = await getPool().query<{ open_id: string }>(
    `SELECT fu.open_id
     FROM production_member pm
     JOIN feishu_user fu ON fu.user_id = pm.user_id
     WHERE pm.production_id = $1 AND pm.status = 'active'
       AND ('制作人' = ANY(pm.roles) OR '制作助理' = ANY(pm.roles))`,
    [productionId],
  );
  return res.rows.map(r => r.open_id);
}

export async function getBossUserIds(productionId: string): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT pm.user_id
     FROM production_member pm
     WHERE pm.production_id = $1 AND pm.status = 'active'
       AND ('制作人' = ANY(pm.roles) OR '制作助理' = ANY(pm.roles))`,
    [productionId],
  );
  return res.rows.map(r => r.user_id);
}
