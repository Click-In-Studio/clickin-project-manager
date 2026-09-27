import { type NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { hasEffectiveGrant, toActor } from "@/lib/perm/grant-check";
import { getFinancialDocumentAsset } from "@/lib/ops/finance-document-db";
import { deleteAsset, AssetInUseError } from "@/lib/asset/db";
import { deleteR2Object, presignedGet } from "@/lib/r2";

type Ctx = { params: Promise<{ id: string; assetId: string }> };

function previewType(mimeType: string | null): "image" | "video" | "audio" | "pdf" | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return mimeType === "application/pdf" ? "pdf" : null;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });

  const document = await getFinancialDocumentAsset(productionId, assetId);
  if (!document) return Response.json({ error: "凭证不存在" }, { status: 404 });
  const canViewAll = await hasEffectiveGrant(
    toActor(session, access.permCtx), productionId, "finance", "*", "expenses", "view");
  const contextual = document.uploaderUserId === session.userId
    || document.linkedExpenses.some(expense =>
      expense.submittedBy === session.userId
      || (expense.status === "pending" && expense.currentApproverIds.includes(session.userId)));
  // expenses@view 只放行已经成为报销附件的文件；暂存上传仍只对上传者自己可见。
  if (!contextual && !(canViewAll && document.linkedExpenses.length > 0))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (!document.r2Key) return Response.json({ error: "文件不存在" }, { status: 404 });

  const download = new URL(req.url).searchParams.get("download") === "1";
  const kind = previewType(document.mimeType);
  if (!download && !kind) return Response.json({ error: "该文件请下载后查看" }, { status: 400 });
  const expiresIn = 300;
  const url = presignedGet(document.r2Key, expiresIn, download ? undefined : {
    inline: true,
    contentType: document.mimeType ?? undefined,
    cacheWindow: expiresIn,
    cacheControl: `private, max-age=${expiresIn}`,
  });
  return Response.json({ url, previewType: kind, fileName: document.fileName, expiresIn });
}

/** 仅清理尚未绑定报销的本人暂存凭证；已绑定后由报销生命周期管理。 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id: productionId, assetId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, session.isAdmin, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived) return Response.json({ error: "已归档的项目不可修改" }, { status: 403 });

  const document = await getFinancialDocumentAsset(productionId, assetId);
  if (!document) return Response.json({ error: "凭证不存在" }, { status: 404 });
  if (document.uploaderUserId !== session.userId)
    return Response.json({ error: "只能移除自己尚未提交的凭证" }, { status: 403 });
  if (document.linkedExpenses.length > 0)
    return Response.json({ error: "凭证已关联报销，不能移除" }, { status: 409 });

  try {
    const { r2Keys } = await deleteAsset(assetId);
    await Promise.allSettled(r2Keys.map(key => deleteR2Object(key)));
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof AssetInUseError)
      return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
