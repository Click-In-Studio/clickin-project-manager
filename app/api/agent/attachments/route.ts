import { type NextRequest, NextResponse } from "next/server";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent/chat/http";
import { productionIdOfSessionKey } from "@/lib/agent/tools/session-identity";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { requireProductionFeature } from "@/lib/account/plan";
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  createPendingAttachment,
  deleteAttachment,
  getAttachmentUploadRecord,
  markAttachmentReady,
} from "@/lib/agent/attachment-db";
import { deleteR2Object, headR2Object, presignedPut } from "@/lib/r2";

export const runtime = "nodejs";

async function requireSessionScope(sessionKey: string, userId: string, isAdmin: boolean): Promise<Response | null> {
  const denied = requireOwnership(sessionKey, userId);
  if (denied) return denied;
  const productionId = productionIdOfSessionKey(sessionKey);
  if (!productionId) return null;
  const access = await getProductionPermissionContext(userId, isAdmin, productionId);
  if (!access) return NextResponse.json({ error: "你不是该制作的成员" }, { status: 403 });
  return requireProductionFeature(productionId, "ai");
}

export async function POST(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  let body: { sessionKey?: unknown; fileName?: unknown; mimeType?: unknown; mediaKind?: unknown; fileSize?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.sessionKey !== "string") return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  if (typeof body.fileName !== "string" || !body.fileName.trim()) return NextResponse.json({ error: "缺少 fileName" }, { status: 400 });
  if (typeof body.mimeType !== "string" || !body.mimeType.trim()) return NextResponse.json({ error: "缺少 mimeType" }, { status: 400 });
  if (body.mediaKind !== undefined && body.mediaKind !== null &&
      (typeof body.mediaKind !== "string" || !/^[a-z][a-z0-9_-]*$/.test(body.mediaKind))) {
    return NextResponse.json({ error: "mediaKind 格式非法" }, { status: 400 });
  }
  if (!Number.isSafeInteger(body.fileSize) || Number(body.fileSize) < 0 || Number(body.fileSize) > AGENT_ATTACHMENT_MAX_BYTES) {
    return NextResponse.json({ error: "附件大小不能超过 50 MB" }, { status: 400 });
  }
  try {
    const scopeDeny = await requireSessionScope(body.sessionKey, auth.userId, auth.isAdmin);
    if (scopeDeny) return scopeDeny;
    const attachment = await createPendingAttachment({
      sessionId: body.sessionKey,
      userId: auth.userId,
      fileName: body.fileName.trim(),
      mimeType: body.mimeType.trim().slice(0, 200),
      mediaKind: typeof body.mediaKind === "string" ? body.mediaKind : null,
      fileSize: Number(body.fileSize),
    });
    try {
      const { url, contentType } = presignedPut(attachment.r2Key, attachment.mimeType, 3600);
      return NextResponse.json({ attachment, uploadUrl: url, contentType }, { status: 201 });
    } catch (err) {
      await deleteAttachment(attachment.id, attachment.sessionId, auth.userId).catch(() => {});
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  let body: { sessionKey?: unknown; attachmentId?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.sessionKey !== "string" || typeof body.attachmentId !== "string") {
    return NextResponse.json({ error: "缺少 sessionKey 或 attachmentId" }, { status: 400 });
  }
  const denied = requireOwnership(body.sessionKey, auth.userId);
  if (denied) return denied;
  try {
    const record = await getAttachmentUploadRecord(body.attachmentId, body.sessionKey, auth.userId);
    if (!record) return NextResponse.json({ error: "附件不存在" }, { status: 404 });
    const head = await headR2Object(record.r2Key);
    if (!head || head.size == null) return NextResponse.json({ error: "附件上传未完成" }, { status: 409 });
    if (head.size > AGENT_ATTACHMENT_MAX_BYTES || head.size !== record.fileSize) {
      await deleteR2Object(record.r2Key).catch(() => {});
      return NextResponse.json({ error: "附件大小与上传声明不一致" }, { status: 409 });
    }
    const attachment = await markAttachmentReady(body.attachmentId, body.sessionKey, auth.userId, head.size);
    if (!attachment) return NextResponse.json({ error: "附件不存在" }, { status: 404 });
    return NextResponse.json({ attachment });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  const sessionKey = req.nextUrl.searchParams.get("sessionKey");
  const attachmentId = req.nextUrl.searchParams.get("attachmentId");
  if (!sessionKey || !attachmentId) return NextResponse.json({ error: "缺少 sessionKey 或 attachmentId" }, { status: 400 });
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;
  try {
    const r2Key = await deleteAttachment(attachmentId, sessionKey, auth.userId);
    if (r2Key) await deleteR2Object(r2Key).catch((err) => console.error(`[agent-attachment] 删除 R2 对象失败 ${r2Key}:`, err));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
