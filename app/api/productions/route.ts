import { type NextRequest } from "next/server";
import { createProduction, listProductions, updateProductionSortOrders } from "@/lib/db";
import { getSession } from "@/lib/session";

let _seq = 0;
function uid(): string {
  return `${Date.now().toString(36)}${(++_seq).toString(36)}`;
}

export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  try {
    const productions = await listProductions({ openId: session.openId, isAdmin: session.isAdmin });
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

  const { name } = (await req.json()) as { name?: string };
  if (!name?.trim()) return Response.json({ error: "剧名不能为空" }, { status: 400 });

  const id = uid();
  try {
    await createProduction(id, name.trim());
    return Response.json({ id }, { status: 201 });
  } catch (err) {
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
