import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getProductionPermissionContext, listCharactersByVersion, setCharacterMembers,
  getActiveVersionId, applyPatchToDB, getVersion,
} from "@/lib/db";
import { tickAndBroadcastSeq } from "@/lib/server-cache";
import { hasGrant } from "@/lib/grant-check";
import { canAccessNode } from "@/lib/grant-template";
import { rejectNonHeadWrite } from "@/lib/head-version";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, access: null };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  return { session, access };
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
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx } = access;
  if (!(permCtx.isAdmin || permCtx.isOwner || await hasGrant(permCtx.userId, id, "script", "*", "blocks", "view"))) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const resolved = await resolveProductionVersion(id, req.nextUrl.searchParams.get("versionId") ?? undefined);
  if (resolved.error) {
    return req.nextUrl.searchParams.has("versionId") ? resolved.error : Response.json([]);
  }
  const { versionId } = resolved;
  const characters = await listCharactersByVersion(versionId);
  return Response.json(characters);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/characters">) {
  const { id } = await ctx.params;
  const { session, access } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const { permCtx, isArchived } = access;
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  // 六步链（行 ∪ 区间，admin/owner 在第 1 步旁路）。裸 hasGrant 只认行，持模板
  // 区间但尚未激活的人拿到的是无指向的「权限不足」——与 cue_list / task / event
  // 的 create 门口径不一致。
  const createAccess = await canAccessNode(permCtx, id, "character", "*", "*", "create");
  if (!createAccess.allowed) {
    return Response.json(
      { error: createAccess.reason === "needs_self_confirm" ? "请先确认创建权限" : "权限不足" },
      { status: 403 },
    );
  }

  const body = await req.json();
  const trimmed = typeof body.name === "string" ? body.name.trim() : "";
  if (!trimmed) return Response.json({ error: "名称不能为空" }, { status: 400 });
  const isAggregate = body.isAggregate === true;
  const memberIds: string[] = isAggregate && Array.isArray(body.memberIds)
    ? body.memberIds.filter((m: unknown) => typeof m === "string")
    : [];

  const nonHead = await rejectNonHeadWrite(id, typeof body.versionId === "string" ? body.versionId : null);
  if (nonHead) return nonHead;
  const resolved = await resolveProductionVersion(id, body.versionId);
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;

  // Load current characters to check for duplicates
  const characters = await listCharactersByVersion(versionId);
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
