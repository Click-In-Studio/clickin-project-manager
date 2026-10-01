/**
 * 项目本体（production 表）数据层：建项目（一个事务：本体行 + owner 成员行 + 初始版本
 * + 主本 + 模版灌入 + 档位 / 配额）、项目列表与「我的项目」、排序、归档、名称 / 简介 /
 * 头像 / 类型 / 水印等元数据、管理后台概览统计。
 *
 * 不在这里：成员名册在 perm/member-db，权限上下文在 perm/permission-context-db，
 * 项目模版是代码常量（production-template.ts），版本与本子各有自己的数据层
 * （script/version-db、script/script-view-db）——建项目只是按顺序调它们。
 */
import { randomBytes } from "node:crypto";
import { getPool } from "../pg";
import { initialKeys, keyStrictlyBetween } from "../lex-order";
import { usesRehearsalMarksByDefault } from "../script/script-types";
import { normalizeProductionTier, type ProductionTier } from "../account/plan";
import { createInitialVersion } from "../script/version-db";
import { createMasterScriptView } from "../script/script-view-db";
import { nodeKeyCandidates } from "../perm/grant-template";

const FINANCE_CATEGORY_EDIT_KEYS = nodeKeyCandidates({
  resourceType: "finance", resourceId: "*", resourceSub: "categories", verb: "edit",
});
const FINANCE_BUDGET_EDIT_KEYS = nodeKeyCandidates({
  resourceType: "finance", resourceId: "*", resourceSub: "budget", verb: "edit",
});

/** 与 canAccessNode 的区间 2-5 步同形；grant 行在列表查询里单独作为第 1 步处理。 */
function financeConfigEligibilitySql(keysParam: "$4" | "$5"): string {
  return `(
    NOT EXISTS (
      SELECT 1 FROM production_member_permission denied
      WHERE denied.production_id = p.id AND denied.user_id = $1 AND NOT denied.granted
        AND denied.permission = ANY(${keysParam}::text[])
    ) AND (
      EXISTS (
        SELECT 1 FROM production_member_role pmr
        JOIN production_role_permission prp ON prp.role_id = pmr.role_id
        WHERE pmr.production_id = p.id AND pmr.user_id = $1
          AND prp.permission_key = ANY(${keysParam}::text[])
      ) OR EXISTS (
        SELECT 1 FROM production_member_permission allowed
        WHERE allowed.production_id = p.id AND allowed.user_id = $1 AND allowed.granted
          AND allowed.permission = ANY(${keysParam}::text[])
      ) OR EXISTS (
        WITH RECURSIVE chain AS (
          SELECT pd.id, pd.parent_id
          FROM production_dept_member pdm
          JOIN production_dept pd ON pd.id = pdm.dept_id
          WHERE pdm.production_id = p.id AND pdm.user_id = $1
          UNION
          SELECT parent.id, parent.parent_id
          FROM production_dept parent JOIN chain child ON parent.id = child.parent_id
        )
        SELECT 1 FROM production_dept_permission pdp
        JOIN chain ON chain.id = pdp.dept_id
        WHERE pdp.production_id = p.id AND pdp.permission_key = ANY(${keysParam}::text[])
      )
    )
  )`;
}

/** 建项目配额超限（事务内硬上限命中）。路由层捕获后转 403。 */
export class ProductionQuotaError extends Error {
  constructor(public readonly maxOwned: number) {
    super(`production quota exceeded (max ${maxOwned})`);
    this.name = "ProductionQuotaError";
  }
}

export async function createProduction(
  id: string,
  name: string,
  /** 必填：production.owner_id NOT NULL，且 owner 是 M-14(c) 责任链的终点，不允许无主演出。 */
  ownerUserId: string,
  productionType?: string,
  productionTypeLabel?: string | null,
  /** 初始项目档位（#280）：free 时不落行（production_plan 无行 = free），高于 free
   *  （internal owner 建项即最高档）与本体同事务落行。档位决策在路由层（lib/account/plan.ts）。 */
  initialPlan?: { tier: string; source: string },
  /** 配额硬上限（#307 review finding 1）：路由层的 count 预检是 TOCTOU 软门，这里在
   *  事务内锁 owner 的 user_plan 行串行化同 owner 并发建项，锁内重数超限抛
   *  ProductionQuotaError。Infinity 档（internal）不传即可。 */
  quota?: { maxOwned: number },
): Promise<void> {
  // 建项目全程一个事务：production 行、owner 的成员行、初始 version、模版灌入，
  // 要么全成要么全不成。以前是三段各自提交（裸 pool.query + createInitialVersion 自己
  // 一个事务 + 模版自己一个事务），中途抛错就在库里留一个没有 version、没有模版的半成品
  // 项目——路由 catch 后回 500，用户以为没建成，项目却还在。以前这种残骸只有 admin
  // 的全量列表看得见，创建放开（#281）+ owner 可见（#282）之后它会直接出现在建项目
  // 的人自己的列表里，必须一次做干净。
  const { applyProductionTemplate } = await import("./production-template");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (quota && Number.isFinite(quota.maxOwned)) {
      // 建项目门保证 creator 必有 user_plan 行；锁它让同 owner 的并发创建排队，
      // 排到的事务在锁内重新 count（READ COMMITTED 每语句新快照，看得见前一个的提交）。
      await client.query("SELECT 1 FROM user_plan WHERE user_id = $1 FOR UPDATE", [ownerUserId]);
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM production WHERE owner_id = $1 AND archived_at IS NULL",
        [ownerUserId],
      );
      if (Number(rows[0].n) >= quota.maxOwned) throw new ProductionQuotaError(quota.maxOwned);
    }
    await client.query(
      "INSERT INTO production (id, name, owner_id, type, type_label, script_config) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
      [
        id,
        name,
        ownerUserId,
        productionType ?? null,
        productionTypeLabel ?? null,
        JSON.stringify({ useRehearsalMarks: usesRehearsalMarksByDefault(productionType) }),
      ],
    );
    // owner 同时落一行 production_member：建项目的人当然在项目里。不给 roles——owner 的
    // 权限走 isOwner 旁路（见 hasEffectiveGrant 族与 requireAdminAccess），这行只管「在不在
    // 项目里」，不碰自动授权。以前建项目的人恒是 admin（列表走全量分支），少这行看不出来；
    // 创建放开后（#281）owner 建完就从自己的项目列表里消失了。
    await client.query(
      "INSERT INTO production_member (production_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [id, ownerUserId],
    );
    if (initialPlan && initialPlan.tier !== "free") {
      await client.query(
        "INSERT INTO production_plan (production_id, tier, source) VALUES ($1, $2, $3)",
        [id, initialPlan.tier, initialPlan.source],
      );
    }
    await createInitialVersion(id, client);
    // 主本（#336 B2）：版式住在 script_view 行上，建项即带一条，缺省 a4/center。
    await createMasterScriptView(id, client);
    // 建项目的全部初始状态——角色名单、部门树、部门静态区间键、cue 模版体系的初始行、
    // 策略档位、审批 TTL——统一由项目模版按类型灌入。
    // 见 lib/production/production-template.ts（模版是代码常量：改它＝改代码＝走 PR）。
    await applyProductionTemplate(id, productionType ?? null, client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function deleteProduction(id: string): Promise<void> {
  await getPool().query("DELETE FROM production WHERE id = $1", [id]);
}

export type ProductionListEntry = {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  description: string;
  avatarUrl: string | null;
  type: string | null;
  typeLabel: string | null;
  language: string | null;
};

type ProductionRow = {
  id: string;
  name: string;
  created_at: Date;
  archived_at: Date | null;
  description: string;
  avatar_url: string | null;
  type: string | null;
  type_label: string | null;
  language: string | null;
};

function mapProductionRow(r: ProductionRow): ProductionListEntry {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
    description: r.description,
    avatarUrl: r.avatar_url ?? null,
    type: r.type ?? null,
    typeLabel: r.type_label ?? null,
    language: r.language ?? null,
  };
}

const PROD_COLS_P = "p.id, p.name, p.created_at, p.archived_at, p.description, p.avatar_url, p.type, p.type_label, p.language";

export async function listProductions(opts: { userId: string; isAdmin: boolean }): Promise<ProductionListEntry[]> {
  const orderBy = "CASE WHEN p.archived_at IS NULL THEN 0 ELSE 1 END, upo.sort_key ASC NULLS LAST, p.created_at ASC, p.id ASC";
  let res;
  if (opts.isAdmin) {
    res = await getPool().query<ProductionRow>(
      `SELECT ${PROD_COLS_P} FROM production p
       LEFT JOIN user_production_order upo ON upo.production_id = p.id AND upo.user_id = $1
       ORDER BY ${orderBy}`,
      [opts.userId],
    );
  } else {
    // owner 单列一条可见路径：owner 不必是成员（getProductionPermissionContext 就是
    // isAdmin/isOwner/isMember 三取一），内连接 production_member 会把「owner 但没有成员行」
    // 的项目整个藏掉。LEFT JOIN + OR owner_id 才与权限判定同口径。
    res = await getPool().query<ProductionRow>(
      `SELECT ${PROD_COLS_P} FROM production p
       LEFT JOIN production_member pm ON pm.production_id = p.id AND pm.user_id = $1
       LEFT JOIN user_production_order upo ON upo.production_id = p.id AND upo.user_id = $1
       WHERE pm.user_id IS NOT NULL OR p.owner_id = $1
       ORDER BY ${orderBy}`,
      [opts.userId]
    );
  }
  return res.rows.map(mapProductionRow);
}

export type MyProductionEntry = {
  id: string; name: string; createdAt: string; archivedAt: string | null;
  roles: string[]; firstTag: string | null; avatarUrl: string | null;
  isOwner: boolean;
  hasAdminPerm: boolean; // true if FK-backed role 区间含治理域节点键（ADMIN_PANEL_NODE_PREFIXES）
  hasFinanceConfigPerm?: boolean;
  planTier: ProductionTier; // 项目付费档位（#280）：无 production_plan 行 = free
};

export async function listMyProductionsWithRoles(
  userId: string, isAdmin: boolean,
  adminPanelPrefixes: readonly string[],
): Promise<MyProductionEntry[]> {
  const orderBy = "CASE WHEN p.archived_at IS NULL THEN 0 ELSE 1 END, upo.sort_key ASC NULLS LAST, p.created_at ASC, p.id ASC";
  const res = await getPool().query<{
    id: string; name: string; created_at: Date; archived_at: Date | null;
    roles: string[] | null; first_tag: string | null;
    avatar_url: string | null; is_owner: boolean; has_admin_perm: boolean; has_finance_config_perm: boolean;
    plan_tier: string | null;
  }>(
    `SELECT p.id, p.name, p.created_at, p.archived_at, p.avatar_url,
            pm.roles, ppl.tier AS plan_tier,
            (
              SELECT pmt.name
              FROM production_member_tag_assignment pmta
              JOIN production_member_tag pmt ON pmt.id = pmta.tag_id
              WHERE pmta.production_id = p.id AND pmta.user_id = $1
              ORDER BY pmt.is_system DESC, pmt.name
              LIMIT 1
            ) AS first_tag,
            (p.owner_id = $1) AS is_owner,
            EXISTS(
              SELECT 1
              FROM production_member_role pmr
              JOIN production_role_permission prp ON prp.role_id = pmr.role_id
              WHERE pmr.production_id = p.id
                AND pmr.user_id = $1
                AND prp.permission_key LIKE ANY($3::text[])
            ) AS has_admin_perm,
            (
              EXISTS (
                SELECT 1 FROM production_member_grant pmg
                WHERE pmg.production_id = p.id AND pmg.user_id = $1
                  AND pmg.resource_type = 'finance' AND pmg.resource_id = '*'
                  AND pmg.resource_sub IN ('categories', 'budget', '*')
                  AND pmg.permission_level = 'edit' AND NOT pmg.is_revoked
                  AND (pmg.expires_at IS NULL OR pmg.expires_at > now())
              ) OR ${financeConfigEligibilitySql("$4")}
                OR ${financeConfigEligibilitySql("$5")}
            ) AS has_finance_config_perm
     FROM production p
     LEFT JOIN production_member pm
            ON pm.production_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
     LEFT JOIN production_plan ppl ON ppl.production_id = p.id
     LEFT JOIN user_production_order upo ON upo.production_id = p.id AND upo.user_id = $1
     -- 在职口径（#141）：退出/被停用之后这个项目就不该再出现在「我的项目」里，
     -- 否则点进去只会撞 403。owner 分支不受影响。
     WHERE ($2 OR pm.user_id IS NOT NULL OR p.owner_id = $1)
     ORDER BY ${orderBy}`,
    [userId, isAdmin, adminPanelPrefixes.map((p) => `${p}%`), FINANCE_CATEGORY_EDIT_KEYS, FINANCE_BUDGET_EDIT_KEYS],
  );
  return res.rows.map(r => ({
    id: r.id, name: r.name,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
    roles: r.roles ?? [],
    firstTag: r.first_tag ?? null,
    avatarUrl: r.avatar_url ?? null,
    isOwner: r.is_owner,
    hasAdminPerm: r.has_admin_perm,
    hasFinanceConfigPerm: r.has_finance_config_perm,
    planTier: normalizeProductionTier(r.plan_tier),
  }));
}

export type ProductionPlacement = { anchorId: string; side: "before" | "after" };

export class ProductionOrderConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionOrderConflictError";
  }
}

type OrderedProductionRow = { id: string; sort_key: string | null };

function newUserProductionOrderId(): string {
  return `upo_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/**
 * 个人项目顺序：调用方只给相对锚点，服务端在完整的活跃项目集合上分配 lex key。
 * 锁 app_user 行串行化同一用户的拖拽；首次排序 / 新加入项目 / key 间隙耗尽时才重铺。
 */
export async function placeProductionForUser(
  userId: string,
  productionId: string,
  place: ProductionPlacement,
): Promise<void> {
  if (productionId === place.anchorId) throw new ProductionOrderConflictError("项目不能以自己为锚点");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM app_user WHERE id = $1 FOR UPDATE", [userId]);
    const { rows } = await client.query<OrderedProductionRow>(
      `SELECT p.id, upo.sort_key
       FROM production p
       LEFT JOIN production_member pm
         ON pm.production_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
       LEFT JOIN user_production_order upo
         ON upo.production_id = p.id AND upo.user_id = $1
       WHERE p.archived_at IS NULL AND (pm.user_id IS NOT NULL OR p.owner_id = $1)
       ORDER BY upo.sort_key ASC NULLS LAST, p.created_at ASC, p.id ASC`,
      [userId],
    );
    if (!rows.some(row => row.id === productionId) || !rows.some(row => row.id === place.anchorId)) {
      throw new ProductionOrderConflictError("项目列表已变化，请刷新后重试");
    }

    const writeKeys = async (ordered: Array<{ id: string; sortKey: string }>) => {
      for (const row of ordered) {
        await client.query(
          `INSERT INTO user_production_order (id, user_id, production_id, sort_key)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, production_id) DO UPDATE
             SET sort_key = EXCLUDED.sort_key, updated_at = now()`,
          [newUserProductionOrderId(), userId, row.id, row.sortKey],
        );
      }
    };

    let keyed = rows;
    if (rows.some(row => row.sort_key === null)) {
      const keys = initialKeys(rows.length);
      await writeKeys(rows.map((row, index) => ({ id: row.id, sortKey: keys[index] })));
      keyed = rows.map((row, index) => ({ ...row, sort_key: keys[index] }));
    }

    const withoutMoved = keyed.filter(row => row.id !== productionId);
    const anchorIndex = withoutMoved.findIndex(row => row.id === place.anchorId);
    const slot = place.side === "before" ? anchorIndex : anchorIndex + 1;
    const prev = slot > 0 ? withoutMoved[slot - 1].sort_key : null;
    const next = slot < withoutMoved.length ? withoutMoved[slot].sort_key : null;
    const nextKey = keyStrictlyBetween(prev, next);
    if (nextKey !== null) {
      await writeKeys([{ id: productionId, sortKey: nextKey }]);
    } else {
      const finalOrder = [...withoutMoved];
      finalOrder.splice(slot, 0, keyed.find(row => row.id === productionId)!);
      const keys = initialKeys(finalOrder.length);
      await writeKeys(finalOrder.map((row, index) => ({ id: row.id, sortKey: keys[index] })));
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
// ── 归档 ──────────────────────────────────────────────────────────────────────

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

// ── 名称 / 元数据 / 概览 ──────────────────────────────────────────────────────

export async function getProductionName(id: string): Promise<string | null> {
  const res = await getPool().query<{ name: string }>(
    "SELECT name FROM production WHERE id = $1",
    [id]
  );
  return res.rows[0]?.name ?? null;
}

export type ProductionMeta = {
  name: string;
  description: string;
  avatarUrl: string | null;
  type: string | null;
  typeLabel: string | null;
  language: string | null;
  watermarkEnabled: boolean;
};

export async function getProductionOwnerInfo(id: string): Promise<{ ownerId: string | null; archived: boolean } | null> {
  const res = await getPool().query<{ owner_id: string | null; archived_at: Date | null }>(
    "SELECT owner_id, archived_at FROM production WHERE id = $1",
    [id],
  );
  if (!res.rows.length) return null;
  return { ownerId: res.rows[0].owner_id, archived: res.rows[0].archived_at != null };
}

export async function getProductionMeta(id: string): Promise<ProductionMeta | null> {
  const res = await getPool().query<{
    name: string;
    description: string;
    avatar_url: string | null;
    type: string | null;
    type_label: string | null;
    language: string | null;
    watermark_enabled: boolean;
  }>(
    "SELECT name, description, avatar_url, type, type_label, language, watermark_enabled FROM production WHERE id = $1",
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    name: r.name,
    description: r.description,
    avatarUrl: r.avatar_url,
    type: r.type,
    typeLabel: r.type_label,
    language: r.language,
    watermarkEnabled: r.watermark_enabled,
  };
}

/** 管理后台·项目概览的基础统计（只读聚合，门=管理面资格）。 */
export async function getAdminOverviewStats(productionId: string): Promise<{
  memberCount: number;
  suspendedCount: number;
  deptCount: number;
  groupCount: number;
  roleCount: number;
  activeGrantCount: number;
  milestoneCount: number;
  announcementCount: number;
  createdAt: string;
  archivedAt: string | null;
}> {
  const res = await getPool().query<{
    member_count: string; suspended_count: string; dept_count: string; group_count: string;
    role_count: string; active_grant_count: string; milestone_count: string; announcement_count: string;
    created_at: Date; archived_at: Date | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM production_member pm
         WHERE pm.production_id = p.id AND pm.status <> 'exited') AS member_count,
       (SELECT COUNT(*) FROM production_member pm WHERE pm.production_id = p.id AND pm.status = 'suspended') AS suspended_count,
       (SELECT COUNT(*) FROM production_dept d WHERE d.production_id = p.id AND d.kind = 'dept') AS dept_count,
       (SELECT COUNT(*) FROM production_dept d WHERE d.production_id = p.id AND d.kind = 'group') AS group_count,
       (SELECT COUNT(*) FROM production_role r WHERE r.production_id = p.id AND NOT r.is_deprecated) AS role_count,
       (SELECT COUNT(*) FROM production_member_grant g WHERE g.production_id = p.id
          AND NOT g.is_revoked AND (g.expires_at IS NULL OR g.expires_at > NOW())) AS active_grant_count,
       (SELECT COUNT(*) FROM milestone m WHERE m.production_id = p.id) AS milestone_count,
       (SELECT COUNT(*) FROM production_announcement a WHERE a.production_id = p.id) AS announcement_count,
       p.created_at, p.archived_at
     FROM production p WHERE p.id = $1`,
    [productionId],
  );
  const r = res.rows[0];
  return {
    memberCount: Number(r?.member_count ?? 0),
    suspendedCount: Number(r?.suspended_count ?? 0),
    deptCount: Number(r?.dept_count ?? 0),
    groupCount: Number(r?.group_count ?? 0),
    roleCount: Number(r?.role_count ?? 0),
    activeGrantCount: Number(r?.active_grant_count ?? 0),
    milestoneCount: Number(r?.milestone_count ?? 0),
    announcementCount: Number(r?.announcement_count ?? 0),
    createdAt: r?.created_at?.toISOString() ?? "",
    archivedAt: r?.archived_at?.toISOString() ?? null,
  };
}

/** 水印渲染信息：开关 + 当前用户 [显示名 邮箱]。production layout SSR 消费。
 *  注：productionId 仅取 watermark_enabled；身份两个 LEFT JOIN 直接按 $2 键连，
 *  与 production 无关联（单行、无 fan-out）。 */
export async function getWatermarkInfo(
  productionId: string,
  userId: string,
): Promise<{ enabled: boolean; name: string; email: string | null }> {
  const res = await getPool().query<{ enabled: boolean; name: string | null; email: string | null }>(
    `SELECT p.watermark_enabled AS enabled,
            COALESCE(up.display_name, up.name, fu.name) AS name,
            COALESCE(
              (SELECT upi.platform_user_id FROM user_platform_identity upi
               WHERE upi.user_id = $2 AND upi.platform_id = 'email'
               ORDER BY upi.is_primary DESC, upi.created_at DESC LIMIT 1),
              fu.email
            ) AS email
     FROM production p
     LEFT JOIN user_profile up ON up.user_id = $2
     LEFT JOIN feishu_user fu ON fu.user_id = $2
     WHERE p.id = $1`,
    [productionId, userId],
  );
  const r = res.rows[0];
  return { enabled: r?.enabled ?? false, name: r?.name ?? "", email: r?.email ?? null };
}

export async function updateProductionName(id: string, name: string): Promise<void> {
  await getPool().query("UPDATE production SET name = $1 WHERE id = $2", [name, id]);
}

export async function updateProductionMeta(
  id: string,
  fields: { description?: string; avatarUrl?: string | null; language?: string | null; watermarkEnabled?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.description !== undefined) { sets.push(`description = $${vals.push(fields.description)}`); }
  if ("avatarUrl" in fields) { sets.push(`avatar_url = $${vals.push(fields.avatarUrl ?? null)}`); }
  if ("language" in fields) { sets.push(`language = $${vals.push(fields.language ?? null)}`); }
  if (fields.watermarkEnabled !== undefined) { sets.push(`watermark_enabled = $${vals.push(fields.watermarkEnabled)}`); }
  if (!sets.length) return;
  vals.push(id);
  await getPool().query(`UPDATE production SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

export async function updateProductionType(
  id: string,
  type: string | null,
  typeLabel: string | null,
): Promise<void> {
  await getPool().query(
    "UPDATE production SET type = $1, type_label = $2 WHERE id = $3",
    [type, typeLabel, id],
  );
}
