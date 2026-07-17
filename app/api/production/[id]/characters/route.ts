import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, listCharactersByVersion, setCharacterMembers,
  getActiveVersionId, loadProduction, applyPatchToDB, ensureScriptMarkerMigration, getVersion,
} from "@/lib/db";
import { tickAndBroadcastSeq } from "@/lib/server-cache";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

async function resolveProductionVersion(productionId: string, requestedVersionId?: unknown) {
  const versionId = ((typeof requestedVersionId === "string" && requestedVersionId) ? requestedVersionId : await getActiveVersionId(productionId)) ?? "";
  if (!versionId) return { error: Response.json({ error: "无可用版本" }, { status: 404 }) };
  const version = await getVersion(versionId);
  if (!version || version.productionId !== productionId) {
    return { error: Response.json({ error: "版本不存在" }, { status: 404 }) };
  }
  return { versionId };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const resolved = await resolveProductionVersion(id, req.nextUrl.searchParams.get("versionId") ?? undefined);
  if (resolved.error) {
    return req.nextUrl.searchParams.has("versionId") ? resolved.error : Response.json([]);
  }
  const { versionId } = resolved;
  const migration = await ensureScriptMarkerMigration(versionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
  }
  const characters = await listCharactersByVersion(versionId);
  return Response.json(characters);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  const trimmed = typeof body.name === "string" ? body.name.trim() : "";
  if (!trimmed) return Response.json({ error: "名称不能为空" }, { status: 400 });
  const isAggregate = body.isAggregate === true;
  const memberIds: string[] = isAggregate && Array.isArray(body.memberIds)
    ? body.memberIds.filter((m: unknown) => typeof m === "string")
    : [];

  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  const migration = await ensureScriptMarkerMigration(versionId);
  if (migration.status === "running") {
    return Response.json({ status: "updating", migration }, { status: 202 });
  }

  // Load current characters to check for duplicates
  const result = await loadProduction(id, versionId);
  const characters = result?.state.characters ?? [];
  if (characters.some((c) => c.name === trimmed)) {
    return Response.json({ error: "角色名已存在" }, { status: 409 });
  }

  const newChar = { id: `c${Date.now().toString(36)}`, name: trimmed, isAggregate };
  await applyPatchToDB(id, versionId, {
    clientSeq: 0, blockOps: [], sceneOps: [],
    charOps: [{ op: "upsert", char: newChar }],
  });
  tickAndBroadcastSeq(id, versionId);

  if (isAggregate && memberIds.length > 0) {
    await setCharacterMembers(id, newChar.id, memberIds);
  }
  const charDetail = { ...newChar, gender: "", biography: "", roleType: "", memberIds };
  return Response.json({ ok: true, char: charDetail }, { status: 201 });
}
