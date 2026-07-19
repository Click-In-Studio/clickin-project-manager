import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  canUserAccessProduction, getVersion, updateVersionMeta, updateVersionStatus,
  rollbackToVersion, getActiveVersionId, ensureScriptMarkerMigration,
} from "@/lib/db";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const ok = session.isAdmin || (await canUserAccessProduction(session.userId, id));
  if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });

  const version = await getVersion(versionId);
  if (!version || version.productionId !== id) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }
  return Response.json({ version });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  if (!session.isAdmin) {
    const ok = await canUserAccessProduction(session.userId, id);
    if (!ok) return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const version = await getVersion(versionId);
  if (!version || version.productionId !== id) {
    return Response.json({ error: "版本不存在" }, { status: 404 });
  }

  const body = (await req.json()) as {
    name?: string;
    description?: string;
    tags?: string[];
    status?: "committed" | "frozen" | "archived";
    rollback?: boolean;
    rollbackName?: string;
  };

  if (body.rollback) {
    const currentVersionId = await getActiveVersionId(id);
    if (!currentVersionId) return Response.json({ error: "无当前编辑版本" }, { status: 400 });
    const migration = await ensureScriptMarkerMigration(versionId);
    if (migration.status === "running") {
      return Response.json({ status: "updating", migration }, { status: 202 });
    }
    const rollbackName = body.rollbackName ?? `回滚至 ${version.name}`;
    const newVersion = await rollbackToVersion(currentVersionId, versionId, id, rollbackName);
    return Response.json({ version: newVersion });
  }

  if (body.status !== undefined) {
    await updateVersionStatus(id, versionId, body.status);
  }

  const metaFields: { name?: string; description?: string; tags?: string[] } = {};
  if (body.name        !== undefined) metaFields.name        = body.name;
  if (body.description !== undefined) metaFields.description = body.description;
  if (body.tags        !== undefined) metaFields.tags        = body.tags;
  if (Object.keys(metaFields).length > 0) await updateVersionMeta(id, versionId, metaFields);

  const updated = await getVersion(versionId);
  return Response.json({ version: updated });
}
