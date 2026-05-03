import { type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getCueList, listCueListPermissions, updateCue, deleteCue,
         getCue, listProductionMembersWithRoles, getProductionName } from "@/lib/db";
import { canEditCueList } from "@/lib/cue-list-types";
import type { CueAnchor } from "@/lib/cue-types";
import { broadcastCueUpdate } from "@/lib/server-cache";
import { sendCard, buildCueWarningCard } from "@/lib/feishu-bot";
import { BASE_PATH } from "@/lib/base-path";
import { getOptedOutUsers } from "@/lib/notification-prefs";

async function getCtx(req: NextRequest, productionId: string) {
  const session = getSession(req.cookies);
  if (!session) return { session: null, memberRoles: null, isArchived: false };
  const { memberRoles, isArchived } = await getProductionMemberContext(session.openId, session.isAdmin, productionId);
  return { session, memberRoles, isArchived };
}

async function checkEdit(req: NextRequest, id: string, cueListId: string) {
  const { session, memberRoles, isArchived } = await getCtx(req, id);
  if (!session) return { ok: false, session: null, memberRoles: null, isArchived: false, status: 401 as const };
  if (isArchived) return { ok: false, session, memberRoles, isArchived, status: 403 as const };
  const [cueList, permissions] = await Promise.all([
    getCueList(cueListId, id),
    listCueListPermissions(cueListId),
  ]);
  if (!cueList) return { ok: false, session, memberRoles, isArchived, status: 404 as const };
  if (!canEditCueList(session.openId, memberRoles, session.isAdmin, cueList, permissions))
    return { ok: false, session, memberRoles, isArchived, status: 403 as const };
  return { ok: true, session, memberRoles, isArchived, status: 200 as const };
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/cues/[cueId]">
) {
  const { id, cueListId, cueId } = await ctx.params;
  const check = await checkEdit(req, id, cueListId);
  if (!check.ok) return Response.json({ error: "权限不足或不存在" }, { status: check.status });

  const versionId = req.nextUrl.searchParams.get("v") ?? undefined;
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
  const [cueList, permissions, members, productionName] = await Promise.all([
    getCueList(cueListId, productionId),
    listCueListPermissions(cueListId),
    listProductionMembersWithRoles(productionId),
    getProductionName(productionId),
  ]);
  if (!cueList) return;

  // Build explicit deny set (canEdit=false override → no notification)
  const denied = new Set(permissions.filter(p => !p.canEdit).map(p => p.openId));

  const recipients = new Set<string>();

  // 1. Creator
  if (!denied.has(cueList.createdBy)) recipients.add(cueList.createdBy);

  // 2. Personal overrides with canEdit=true
  for (const p of permissions) {
    if (p.canEdit) recipients.add(p.openId);
  }

  // 3. Members whose roles match defaultEditRoles
  if (cueList.defaultEditRoles.length > 0) {
    for (const m of members) {
      if (denied.has(m.openId)) continue;
      if (m.roles.some(r => cueList.defaultEditRoles.includes(r))) {
        recipients.add(m.openId);
      }
    }
  }

  if (recipients.size === 0) return;

  const [optedOut, appId] = [await getOptedOutUsers("cue_warning"), process.env.FEISHU_APP_ID ?? ""];
  const cuePath = `${BASE_PATH}/production/${productionId}/cuelists/${cueListId}`;
  const url = `https://applink.feishu.cn/client/web_app/open?appId=${appId}&path=${encodeURIComponent(cuePath)}`;
  const card = buildCueWarningCard(productionName ?? "制作", cueList.name, cueNumber, cueName, url);

  for (const openId of recipients) {
    if (optedOut.has(openId)) continue;
    sendCard(openId, card).catch(e =>
      console.error(`[cue-warning] dm failed for ${openId}:`, (e as Error).message)
    );
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/production/[id]/cuelists/[cueListId]/cues/[cueId]">
) {
  const { id, cueListId, cueId } = await ctx.params;
  const check = await checkEdit(req, id, cueListId);
  if (!check.ok) return Response.json({ error: "权限不足或不存在" }, { status: check.status });

  const versionId = req.nextUrl.searchParams.get("v") ?? undefined;
  await deleteCue(cueId, cueListId, versionId);
  broadcastCueUpdate(id);
  return Response.json({ ok: true });
}
