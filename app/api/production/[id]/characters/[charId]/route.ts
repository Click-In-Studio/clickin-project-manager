import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionMemberContext, patchCharacterMeta, setCharacterMembers,
  getActiveVersionId, listCharactersByVersion, applyPatchToDB, getVersion,
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

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters/[charId]">) {
  const { id, charId } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();

  // memberIds: replace the full set of aggregate members
  if ("memberIds" in body) {
    const memberIds: string[] = Array.isArray(body.memberIds)
      ? body.memberIds.filter((m: unknown) => typeof m === "string")
      : [];
    const resolved = await resolveProductionVersion(id, body.versionId);
    if (resolved.error) return resolved.error;
    await setCharacterMembers(id, charId, memberIds);
    return Response.json({ ok: true });
  }

  // Metadata fields go directly to DB (not through patch)
  const hasMeta = "gender" in body || "biography" in body || "roleType" in body;
  if (hasMeta) {
    const meta: { gender?: string; biography?: string; roleType?: string } = {};
    if (typeof body.gender    === "string") meta.gender    = body.gender;
    if (typeof body.biography === "string") meta.biography = body.biography;
    if (typeof body.roleType  === "string") meta.roleType  = body.roleType;
    const metaVersionId = (typeof body.versionId === "string" && body.versionId)
      ? body.versionId
      : (() => {
          console.error(`[fallback] PATCH /characters/${charId}: no versionId in body — frontend bug`);
          return getActiveVersionId(id);
        })();
    const resolvedMetaVersionId = typeof metaVersionId === "string" ? metaVersionId : await metaVersionId;
    const resolved = await resolveProductionVersion(id, resolvedMetaVersionId);
    if (resolved.error) return resolved.error;
    await patchCharacterMeta(charId, resolved.versionId, meta);
    return Response.json({ ok: true });
  }

  // Structural fields (name, isAggregate)
  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;

  const char = (await listCharactersByVersion(versionId)).find((c) => c.id === charId);
  if (!char) return Response.json({ error: "未找到角色" }, { status: 404 });

  const nameVal = typeof body.name === "string" ? body.name.trim() : char.name;
  if (!nameVal) return Response.json({ error: "名称不能为空" }, { status: 400 });

  const updated = {
    ...char,
    name: nameVal,
    isAggregate: typeof body.isAggregate === "boolean" ? body.isAggregate : char.isAggregate,
  };
  await applyPatchToDB(id, versionId, {
    clientSeq: 0, blockOps: [], sceneOps: [],
    charOps: [{ op: "upsert", char: updated }],
  });
  tickAndBroadcastSeq(id, versionId);

  // When converting to/from aggregate, clear member associations
  if (typeof body.isAggregate === "boolean" && body.isAggregate !== char.isAggregate) {
    await setCharacterMembers(id, charId, []);
  }

  return Response.json({ ok: true, char: updated });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters/[charId]">) {
  const { id, charId } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(_req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await _req.json().catch(() => ({}));
  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;

  await applyPatchToDB(id, versionId, {
    clientSeq: 0, blockOps: [], sceneOps: [],
    charOps: [{ op: "delete", id: charId }],
  });
  tickAndBroadcastSeq(id, versionId);
  return Response.json({ ok: true });
}
