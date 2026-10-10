import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { getCueList, listCueListRoleMembers, hasListAccess } from "@/lib/ops/cue-list-db";
import { updateCueConditionally, deleteCue } from "@/lib/ops/cue-db";
import { CuePatchConflict, type CueFieldPatch, type CuePatchBasis } from "@/lib/ops/cue-edit-types";
import { getProductionName } from "@/lib/production/production-db";
import { getVersion } from "@/lib/script/version-db";
import { broadcastCueUpdate } from "@/lib/server-cache";
import { buildCueWarningCard } from "@/lib/platform/feishu/feishu-bot";
import { SERVER_URL } from "@/lib/server-url";
import { notifyUsers } from "@/lib/notify/notify";
import { rejectNonHeadWrite } from "@/lib/script/head-version";

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

  const nonHead = await rejectNonHeadWrite(id, req.nextUrl.searchParams.get("v"));
  if (nonHead) return nonHead;
  const resolved = await resolveVersion(id, req.nextUrl.searchParams.get("v"));
  if (resolved.error) return resolved.error;
  const { versionId } = resolved;
  const { basis, ...fields } = await req.json() as CueFieldPatch & { basis?: CuePatchBasis };
  if (!basis || typeof basis !== "object" || Array.isArray(basis)) {
    return Response.json({ error: "缺少编辑依据，请重新加载 Cue", code: "CUE_PATCH_CONFLICT" }, { status: 409 });
  }

  // Snapshot current warning state before update (for notification trigger)
  let saved;
  try {
    saved = await updateCueConditionally(cueId, cueListId, fields, basis, versionId);
  } catch (error) {
    if (error instanceof CuePatchConflict) {
      return Response.json({ error: "Cue 已被修改或删除，本地修改未上传", code: "CUE_PATCH_CONFLICT" }, { status: 409 });
    }
    throw error;
  }
  broadcastCueUpdate(id);

  // Fire-and-forget: notify cue list editors when a warning is newly set
  if (saved.warningNewlySet) {
    notifyCueWarning(id, cueListId, cueId, saved.cue.number, saved.cue.name).catch(e =>
      console.error("[cue-warning] notify failed:", e)
    );
  }

  return Response.json({ ok: true, cue: saved.cue });
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

  const cuePath = `${SERVER_URL}/production/${productionId}/cuelists/${cueListId}`;
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

  const nonHead = await rejectNonHeadWrite(id, req.nextUrl.searchParams.get("v"));
  if (nonHead) return nonHead;
  const resolved = await resolveVersion(id, req.nextUrl.searchParams.get("v"));
  if (resolved.error) return resolved.error;
  await deleteCue(cueId, cueListId);
  broadcastCueUpdate(id);
  return Response.json({ ok: true });
}
