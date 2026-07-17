import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getCueList, listCueListPermissions, listCues, createCue, getVersion } from "@/lib/db";
import { canEditCueList } from "@/lib/cue-list-types";
import type { CueAnchor } from "@/lib/cue-types";
import { broadcastCueUpdate } from "@/lib/server-cache";

let _seq = 0;
const uid = () => `cue${Date.now().toString(36)}${(++_seq).toString(36)}`;

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, isArchived: false };
  const { memberRoles, isArchived } = await getProductionMemberContext(session.userId, session.isAdmin, productionId);
  return { session, memberRoles, isArchived };
}

async function resolveVersion(productionId: string, versionId?: string | null) {
  if (!versionId) return { versionId: undefined };
  const version = await getVersion(versionId);
  if (!version || version.productionId !== productionId) {
    return { error: Response.json({ error: "版本不存在" }, { status: 404 }) };
  }
  return { versionId };
}

export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/cues">
) {
  const { id, cueListId } = await ctx.params;
  const { session } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const resolved = await resolveVersion(id, req.nextUrl.searchParams.get("v"));
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  const cues = await listCues(cueListId, versionId);
  return Response.json(cues);
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/cues">
) {
  const { id, cueListId } = await ctx.params;
  const { session, memberRoles, isArchived } = await getCtx(req, id);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const [cueList, permissions] = await Promise.all([
    getCueList(cueListId, id),
    listCueListPermissions(cueListId),
  ]);
  if (!cueList) return Response.json({ error: "不存在" }, { status: 404 });
  if (!canEditCueList(session.userId, memberRoles, session.isAdmin, cueList, permissions))
    return Response.json({ error: "权限不足" }, { status: 403 });

  const resolved = await resolveVersion(id, req.nextUrl.searchParams.get("v"));
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  const body = await req.json() as { number: string; name?: string; content?: string; start: CueAnchor; end: CueAnchor };
  if (!body.number?.trim()) return Response.json({ error: "编号不能为空" }, { status: 400 });
  if (!body.start || !body.end) return Response.json({ error: "缺少位置信息" }, { status: 400 });

  await createCue({
    id: uid(),
    cueListId,
    number: body.number.trim(),
    name: body.name?.trim() ?? "",
    content: body.content?.trim() ?? "",
    start: body.start,
    end: body.end,
    versionId,
  });

  const cues = await listCues(cueListId, versionId);
  broadcastCueUpdate(id);
  return Response.json(cues, { status: 201 });
}
