import { type NextRequest } from "next/server";
import { getState, applyPatch } from "@/lib/server-cache";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, listProductionScenes, getActiveVersionId } from "@/lib/db";
import { hasPermission } from "@/lib/roles";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, overrides: new Map(), isArchived: false };
  const { memberRoles, overrides, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, overrides, isArchived };
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "无权访问" }, { status: 403 });
  }
  const scenes = await listProductionScenes(id);
  return Response.json(scenes);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/production/[id]/scenes">) {
  const { id } = await ctx.params;
  const { session, memberRoles, overrides, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });
  if (!hasPermission("script:metadata", session.isAdmin, memberRoles, overrides)) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }

  const body = await req.json();
  const number   = typeof body.number   === "string" ? body.number.trim()   : "";
  const name     = typeof body.name     === "string" ? body.name.trim()     : "";
  const parentId = typeof body.parentId === "string" ? body.parentId        : null;

  const versionId = await getActiveVersionId(id) ?? '';
  const state = getState(id, versionId);
  const newScene = { id: `s${Date.now().toString(36)}`, number, name, parentId };

  // Build a reordered list: insert sub-scene after its parent's last child, or at end for acts
  const scenes = [...state.scenes];
  if (parentId) {
    let insertAfter = scenes.findIndex((s) => s.id === parentId);
    for (let i = insertAfter + 1; i < scenes.length; i++) {
      if (scenes[i].parentId === parentId) insertAfter = i;
      else break;
    }
    scenes.splice(insertAfter + 1, 0, newScene);
  } else {
    scenes.push(newScene);
  }

  await applyPatch(id, versionId, {
    clientSeq: 0,
    blockOps: [],
    charOps: [],
    sceneOps: [
      { op: "upsert", scene: newScene },
      { op: "reorder", ids: scenes.map((s) => s.id) },
    ],
  });
  const sceneDetail = { ...newScene, synopsis: "", actionLine: "", music: "", stageNotes: "", expectedDuration: "" };
  return Response.json({ ok: true, scene: sceneDetail }, { status: 201 });
}
