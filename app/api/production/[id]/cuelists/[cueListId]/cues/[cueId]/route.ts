import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionPermissionContext, getCueList, updateCue, deleteCue,
         getCue, listCueListRoleMembers, getProductionName, getVersion, hasListAccess } from "@/lib/db";
import type { CueAnchor } from "@/lib/cue-types";
import { broadcastCueUpdate } from "@/lib/server-cache";
import { buildCueWarningCard } from "@/lib/platform/feishu/feishu-bot";
import { BASE_PATH } from "@/lib/base-path";
import { notifyUsers } from "@/lib/notify";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, isArchived: false };
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return { session, isArchived: false };
  return { session, isArchived: access.isArchived };
}

async function checkEdit(req: NextRequest, id: string, cueListId: string) {
  const { session, isArchived } = await getCtx(req, id);
  if (!session) return { ok: false, session: null, isArchived: false, status: 401 as const };
  if (isArchived) return { ok: false, session, isArchived, status: 403 as const };
  const [cueList, canEdit] = await Promise.all([
    getCueList(cueListId, id),
    hasListAccess(cueListId, session.userId),
  ]);
  if (!cueList) return { ok: false, session, isArchived, status: 404 as const };
  if (!canEdit) return { ok: false, session, isArchived, status: 403 as const };
  return { ok: true, session, isArchived, status: 200 as const };
}

async function resolveVersion(productionId: string, versionId?: string | null) {
  if (!versionId) return { versionId: undefined };
  const version = await getVersion(versionId);
  if (!version || version.productionId !== productionId) {
    return { error: Response.json({ error: "版本不存在" }, { status: 404 }) };
  }
  return { versionId };
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/cues/[cueId]">
) {
  const { id, cueListId, cueId } = await ctx.params;
  const check = await checkEdit(req, id, cueListId);
  if (!check.ok) return Response.json({ error: "权限不足或不存在" }, { status: check.status });

  const resolved = await resolveVersion(id, req.nextUrl.searchParams.get("v"));
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  const body = await req.json() as {
    number?: string; name?: string; content?: string;
    start?: CueAnchor; end?: CueAnchor; warning?: boolean;
  };

  // Snapshot current warning state before update (for notification trigger)
  const prevCue = body.warning === true ? await getCue(cueId, cueListId) : null;
  const warningNewlySet = body.warning === true && prevCue !== null && !prevCue.warning;

  try {
    await updateCue(cueId, cueListId, {
      number:  body.number  !== undefined ? body.number.trim()  : undefined,
      name:    body.name    !== undefined ? body.name.trim()    : undefined,
      content: body.content !== undefined ? body.content.trim() : undefined,
      start:   body.start,
      end:     body.end,
      warning: body.warning,
    }, versionId);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("CUE_NUMBER_CONFLICT:")) {
      const conflictVersionId = e.message.slice("CUE_NUMBER_CONFLICT:".length);
      return Response.json(
        { error: "cue_number_conflict", conflictVersionId },
        { status: 409 }
      );
    }
    throw e;
  }
  broadcastCueUpdate(id);

  // Fire-and-forget: notify cue list editors when a warning is newly set
  if (warningNewlySet) {
    notifyCueWarning(id, cueListId, cueId, prevCue!.number, prevCue!.name).catch(e =>
      console.error("[cue-warning] notify failed:", e)
    );
  }

  return Response.json({ ok: true });
}

async function notifyCueWarning(
  productionId: string, cueListId: string, _cueId: string,
  cueNumber: string, cueName: string,
): Promise<void> {
  const [cueList, productionName, roleEditorUserIds] = await Promise.all([
    getCueList(cueListId, productionId),
    getProductionName(productionId),
    listCueListRoleMembers(cueListId),
  ]);
  if (!cueList) return;

  const recipients = [...new Set([cueList.createdBy, ...roleEditorUserIds])];
  if (!recipients.length) return;

  const cuePath = `${BASE_PATH}/production/${productionId}/cuelists/${cueListId}`;
  await notifyUsers({
    userIds: recipients,
    kind: "cue_warning",
    productionId,
    entityType: "cue_list",
    entityId: cueListId,
    title: `Cue 报警 — #${cueNumber}${cueName ? ` ${cueName}` : ""}`,
    body: `《${productionName ?? "制作"}》${cueList.name}`,
    viewHref: cuePath,
    category: "warning",
    buildExternalMessage: async (_userId, target) => {
      const actionUrl = target.adapter.buildActionUrl(cuePath);
      const card = buildCueWarningCard(productionName ?? "制作", cueList.name, cueNumber, cueName, actionUrl);
      return {
        text: `你负责的 Cue #${cueNumber}${cueName ? ` ${cueName}` : ""} 被标记为报警`,
        title: "Cue 报警",
        primaryUrl: actionUrl,
        richContent: card,
      };
    },
  });
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/cues/[cueId]">
) {
  const { id, cueListId, cueId } = await ctx.params;
  const check = await checkEdit(req, id, cueListId);
  if (!check.ok) return Response.json({ error: "权限不足或不存在" }, { status: check.status });

  const resolved = await resolveVersion(id, req.nextUrl.searchParams.get("v"));
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  await deleteCue(cueId, cueListId, versionId);
  broadcastCueUpdate(id);
  return Response.json({ ok: true });
}
