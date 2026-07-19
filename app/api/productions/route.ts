import { type NextRequest } from "next/server";
import { createProduction, listProductions, updateProductionSortOrders } from "@/lib/db";
import { getSession } from "@/lib/session";

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

export async function POST(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const ikey = req.headers.get("Idempotency-Key");
  if (ikey) {
    const cached = checkIdem(ikey);
    if (cached) return Response.json({ id: cached }, { status: 201 });
  }

  const { name } = (await req.json()) as { name?: string };  // async gap
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
    await createProduction(id, name.trim());
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    // Remove reservation so the client can retry with a fresh key.
    if (ikey) _idemCache.delete(ikey);
    console.error("[productions] create error:", err);
    return Response.json({ error: "创建失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "权限不足" }, { status: 403 });

  const { id } = (await req.json()) as { id?: string };
  if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });

  try {
    const { deleteProduction } = await import("@/lib/db");
    await deleteProduction(id);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[productions] delete error:", err);
    return Response.json({ error: "删除失败" }, { status: 500 });
  }
}

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
