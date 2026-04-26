import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getCueList, listCueListPermissions, updateCue, deleteCue } from "@/lib/db";
import { canEditCueList } from "@/lib/cue-list-types";
import type { CueAnchor } from "@/lib/cue-types";
import { broadcastCueUpdate } from "@/lib/server-cache";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null };
  const { memberRoles } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles };
}

async function checkEdit(req: NextRequest, id: string, cueListId: string) {
  const { session, memberRoles } = await getCtx(req, id);
  if (!session) return { ok: false, session: null, memberRoles: null, status: 401 as const };
  const [cueList, permissions] = await Promise.all([
    getCueList(cueListId, id),
    listCueListPermissions(cueListId),
  ]);
  if (!cueList) return { ok: false, session, memberRoles, status: 404 as const };
  if (!canEditCueList(session.openId, memberRoles, session.isAdmin, cueList, permissions))
    return { ok: false, session, memberRoles, status: 403 as const };
  return { ok: true, session, memberRoles, status: 200 as const };
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/cues/[cueId]">
) {
  const { id, cueListId, cueId } = await ctx.params;
  const check = await checkEdit(req, id, cueListId);
  if (!check.ok) return Response.json({ error: "权限不足或不存在" }, { status: check.status });

  const body = await req.json() as {
    number?: string; name?: string; content?: string;
    start?: CueAnchor; end?: CueAnchor; warning?: boolean;
  };
  await updateCue(cueId, cueListId, {
    number:  body.number  !== undefined ? body.number.trim()  : undefined,
    name:    body.name    !== undefined ? body.name.trim()    : undefined,
    content: body.content !== undefined ? body.content.trim() : undefined,
    start:   body.start,
    end:     body.end,
    warning: body.warning,
  });
  broadcastCueUpdate(id);
  return Response.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/cues/[cueId]">
) {
  const { id, cueListId, cueId } = await ctx.params;
  const check = await checkEdit(req, id, cueListId);
  if (!check.ok) return Response.json({ error: "权限不足或不存在" }, { status: check.status });

  await deleteCue(cueId, cueListId);
  broadcastCueUpdate(id);
  return Response.json({ ok: true });
}
