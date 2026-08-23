import { type NextRequest } from "next/server";
import { createProduction, listProductions, updateProductionSortOrders, ProductionQuotaError } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getUserTier, countOwnedActiveProductions, USER_TIERS } from "@/lib/plan";

let _seq = 0;
function uid(): string {
  return `${Date.now().toString(36)}${(++_seq).toString(36)}`;
}

// Idempotency cache for production creation — prevents duplicate rows on network retry.
// Module-level state is process-scoped; sufficient for single-process deployments.
const _idemCache = new Map<string, { id: string; ts: number }>();
const IDEM_TTL_MS = 60_000;
function checkIdem(key: string): string | null {
  const entry = _idemCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > IDEM_TTL_MS) { _idemCache.delete(key); return null; }
  return entry.id;
}
function storeIdem(key: string, id: string) {
  _idemCache.set(key, { id, ts: Date.now() });
  // Evict stale entries opportunistically
  if (_idemCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of _idemCache) {
      if (now - v.ts > IDEM_TTL_MS) _idemCache.delete(k);
    }
  }
}

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  try {
    const productions = await listProductions({ userId: session.userId, isAdmin: session.isAdmin });
    return Response.json({ productions });
  } catch (err) {
    console.error("[productions] list error:", err);
    return Response.json({ error: "查询失败" }, { status: 500 });
  }
}

// 建项目的门是用户等级（#280，本文件曾无门放开）：user_plan 无行的普通注册用户
// 不能建（可正常使用被邀请进入的项目），有行（creator/internal）才可建、按档位限
// 「能建几个」。这是用户等级全站唯一的消费点——功能跟项目走，人的等级不影响项目内
// 功能（那些看 production_plan，见 lib/plan.ts）。
//
// 历史：这里原本的门是 session.isAdmin。isAdmin 唯一来源是 feishu_user.is_super_admin，
// 65e1a78 起飞书登录写死 false、db/add-strip-super-admin.sql 又把存量清零，于是那条门
// 变成无人能过的孤门。不要退回 isAdmin（那是 hasPermission 时代的全站旁路）。
export async function POST(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  // 等级实时查库、不走 session payload（HMAC cookie 7 天 TTL 会让升级不生效）。
  const tier = await getUserTier(session.userId);
  if (!tier) {
    return Response.json(
      { error: "当前账号暂无创建项目权限，请在个人中心兑换邀请码提升等级" },
      { status: 403 },
    );
  }
  const tierConf = USER_TIERS[tier];
  // 快路径预检（省一次事务）；硬上限在 createProduction 事务内锁 user_plan 行重判，
  // 并发双请求不会双双越过（#307 review finding 1）。
  const owned = await countOwnedActiveProductions(session.userId);
  if (owned >= tierConf.maxOwnedProductions) {
    return Response.json(
      { error: `已达当前等级可创建的项目数上限（${tierConf.maxOwnedProductions} 个）` },
      { status: 403 },
    );
  }

  const ikey = req.headers.get("Idempotency-Key");
  if (ikey) {
    const cached = checkIdem(ikey);
    if (cached) return Response.json({ id: cached }, { status: 201 });
  }

  const { name, description, type, typeLabel, language } = (await req.json()) as {
    name?: string; description?: string; type?: string; typeLabel?: string; language?: string;
  };  // async gap
  if (!name?.trim()) return Response.json({ error: "剧名不能为空" }, { status: 400 });

  // Re-check after the async body parse: a concurrent request with the same key
  // may have reserved an id while we were awaiting req.json().
  if (ikey) {
    const cached = checkIdem(ikey);
    if (cached) return Response.json({ id: cached }, { status: 201 });
  }

  const id = uid();
  // Reserve synchronously before any await. No other JS can run between here
  // and the next await, so this closes the concurrent-request race window.
  if (ikey) storeIdem(ikey, id);

  try {
    const { updateProductionMeta } = await import("@/lib/db");
    await createProduction(
      id,
      name.trim(),
      session.userId,
      type,
      type === "other" ? (typeLabel?.trim() ?? null) : null,
      // internal 建项即最高档（声明式例外，常量表一格）；free 不落行。
      { tier: tierConf.initialProductionTier, source: tier === "internal" ? "internal_owner" : "initial" },
      Number.isFinite(tierConf.maxOwnedProductions) ? { maxOwned: tierConf.maxOwnedProductions } : undefined,
    );
    const metaFields: Parameters<typeof updateProductionMeta>[1] = {};
    if (description?.trim()) metaFields.description = description.trim();
    if (language?.trim()) metaFields.language = language.trim();
    if (Object.keys(metaFields).length) await updateProductionMeta(id, metaFields);
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    // Remove reservation so the client can retry with a fresh key.
    if (ikey) _idemCache.delete(ikey);
    if (err instanceof ProductionQuotaError) {
      return Response.json(
        { error: `已达当前等级可创建的项目数上限（${err.maxOwned} 个）` },
        { status: 403 },
      );
    }
    console.error("[productions] create error:", err);
    return Response.json({ error: "创建失败" }, { status: 500 });
  }
}

// 这里没有 DELETE：删项目是 owner-only 的 root 操作，已由 DELETE /api/production/[id]
// 承担（那条查 getProductionPermissionContext 后要求 isOwner）。本文件原有一条 isAdmin 门的
// 复数版 DELETE，前端无任何调用点，是漏删的旧路由——两条门判定不同的删项目路径本身就是隐患，
// 已移除。要删项目请走 /api/production/[id]。

// 排序写的是 production.sort_order —— 一个全局列，任何人重排都会改所有人看到的顺序。
// 语义不成立，应迁到 per-user 排序表，见 #279。在那之前保持 isAdmin 门（=当前无人能过，
// 前端也没有调用点），不放开：放开等于把「改所有人的顺序」开放给所有人。
export async function PATCH(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const { orderedIds } = (await req.json()) as { orderedIds?: string[] };
  if (!Array.isArray(orderedIds)) return Response.json({ error: "缺少 orderedIds" }, { status: 400 });

  try {
    await updateProductionSortOrders(orderedIds);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[productions] sort error:", err);
    return Response.json({ error: "排序失败" }, { status: 500 });
  }
}
