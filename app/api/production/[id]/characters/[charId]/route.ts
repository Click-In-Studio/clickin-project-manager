import { type NextRequest } from "next/server";
import { getState, applyPatch } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, patchCharacterMeta, setCharacterMembers, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
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
    await setCharacterMembers(charId, memberIds);
    return Response.json({ ok: true });
  }

  // Metadata fields go directly to DB (not through cache)
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
    if (!resolvedMetaVersionId) return Response.json({ error: "无可用版本" }, { status: 400 });
    await patchCharacterMeta(charId, resolvedMetaVersionId, meta);
    return Response.json({ ok: true });
  }

  // Structural fields (name, isAggregate) go through the cache
  const versionId = await getActiveVersionId(id) ?? '';
  const state = getState(id, versionId);
  const char = state.characters.find((c) => c.id === charId);
  if (!char) return Response.json({ error: "未找到角色" }, { status: 404 });

  // name is optional — if omitted, keep existing
  const nameVal = typeof body.name === "string" ? body.name.trim() : char.name;
  if (!nameVal) return Response.json({ error: "名称不能为空" }, { status: 400 });

  const updated = {
    ...char,
    name: nameVal,
    isAggregate: typeof body.isAggregate === "boolean" ? body.isAggregate : char.isAggregate,
  };
  await applyPatch(id, versionId, { clientSeq: 0, blockOps: [], charOps: [{ op: "upsert", char: updated }], sceneOps: [] });

  // When converting to/from aggregate, clear member associations
  if (typeof body.isAggregate === "boolean" && body.isAggregate !== char.isAggregate) {
    await setCharacterMembers(charId, []);
  }

  return Response.json({ ok: true, char: updated });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters/[charId]">) {
  const { id, charId } = await ctx.params;
  const req = _req;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const delVersionId = await getActiveVersionId(id) ?? '';
  await applyPatch(id, delVersionId, { clientSeq: 0, blockOps: [], charOps: [{ op: "delete", id: charId }], sceneOps: [] });
  return Response.json({ ok: true });
}
