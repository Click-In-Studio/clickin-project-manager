import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { listMemoryProjects, mutateMemoryEntry, readMemoryScope, MemoryAccessError, MemoryConflictError, MemoryValidationError } from "@/lib/agent/memory/memory-db";

function errorResponse(err: unknown) {
  if (err instanceof MemoryValidationError) return Response.json({ error: err.message }, { status: 400 });
  if (err instanceof MemoryAccessError) return Response.json({ error: err.message }, { status: 403 });
  if (err instanceof MemoryConflictError) return Response.json({ error: err.message }, { status: 409 });
  console.error("[memories]", err);
  return Response.json({ error: "记忆操作失败，请重试" }, { status: 500 });
}
export async function GET(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const productionId = req.nextUrl.searchParams.get("productionId") || null;
    const memory = await readMemoryScope(session.userId, productionId);
    return Response.json({ memory, projects: await listMemoryProjects(session.userId) });
  } catch (err) { return errorResponse(err); }
}
export async function PATCH(req: NextRequest) {
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: "无效请求" }, { status: 400 }); }
  if (!body || !["create", "update", "delete", "restore"].includes(String(body.action))
    || (body.productionId != null && typeof body.productionId !== "string")
    || (!["delete", "restore"].includes(String(body.action)) && (typeof body.body !== "string" || !body.body.trim() || body.body.length > 1000))
    || (body.action !== "create" && (typeof body.id !== "string" || !Number.isSafeInteger(body.revision)))) {
    return Response.json({ error: "无效记忆内容" }, { status: 400 });
  }
  try {
    const productionId = typeof body.productionId === "string" && body.productionId ? body.productionId : null;
    await mutateMemoryEntry(session.userId, productionId, { action: body.action as "create" | "update" | "delete" | "restore",
      id: body.id as string | undefined, body: body.body as string | undefined, revision: body.revision as number | undefined, actor: "user" });
    try { await (await import("@/lib/agent/memory/memory-jobs")).enqueueMemoryMaintenance(session.userId, productionId); }
    catch { console.warn("[memories] 记忆已保存，缓存整理待重试"); }
    return Response.json({ memory: await readMemoryScope(session.userId, productionId) });
  } catch (err) { return errorResponse(err); }
}
