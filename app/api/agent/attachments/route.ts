import { type NextRequest, NextResponse } from "next/server";
import { requireOwnership, requireUser, toErrorResponse } from "@/lib/agent/chat/http";
import { productionIdOfSessionKey } from "@/lib/agent/tools/session-identity";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { requireProductionFeature } from "@/lib/account/plan";
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  createPendingAttachment,
  getAttachmentUsage,
  getAttachmentUploadRecord,
  markAttachmentReady,
  listAttachmentsForSession,
  restoreReleasedAttachment,
  runAttachmentGcBatch,
  scheduleAttachmentDeletion,
} from "@/lib/agent/attachment-db";
import { headR2Object, presignedPut } from "@/lib/r2";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  const sessionKey = req.nextUrl.searchParams.get("sessionKey");
  if (!sessionKey) return NextResponse.json({ error: "缺少 sessionKey" }, { status: 400 });
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;
  try {
    const [usage, attachments] = await Promise.all([
      getAttachmentUsage(auth.userId, sessionKey), listAttachmentsForSession(sessionKey),
    ]);
    return NextResponse.json({
      usage,
      attachments: attachments.map(({ id, fileName, mimeType, mediaKind, fileSize, status, expiresAt, releaseUntil, promotedAssetId }) =>
        ({ id, fileName, mimeType, mediaKind, fileSize, status, expiresAt, releaseUntil, promotedAssetId })),
    });
  }
  catch (err) { return toErrorResponse(err); }
}

async function requireSessionScope(sessionKey: string, userId: string): Promise<Response | null> {
  const denied = requireOwnership(sessionKey, userId);
  if (denied) return denied;
  const productionId = productionIdOfSessionKey(sessionKey);
  if (!productionId) return null;
  // session.isAdmin 是退役死字段；成员门不依赖平台管理员旁路。
  const access = await getProductionPermissionContext(userId, false, productionId);
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
    const scopeDeny = await requireSessionScope(body.sessionKey, auth.userId);
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
      await scheduleAttachmentDeletion(attachment.id, attachment.sessionId, auth.userId).catch(() => {});
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = requireUser(req.cookies);
  if (auth instanceof NextResponse) return auth;
  let body: { sessionKey?: unknown; attachmentId?: unknown; action?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.sessionKey !== "string" || typeof body.attachmentId !== "string") {
    return NextResponse.json({ error: "缺少 sessionKey 或 attachmentId" }, { status: 400 });
  }
  const denied = requireOwnership(body.sessionKey, auth.userId);
  if (denied) return denied;
  try {
    if (body.action === "restore") {
      const attachment = await restoreReleasedAttachment(body.attachmentId, body.sessionKey, auth.userId);
      if (!attachment) return NextResponse.json({ error: "附件已不能恢复" }, { status: 409 });
      return NextResponse.json({ attachment });
    }
    const record = await getAttachmentUploadRecord(body.attachmentId, body.sessionKey, auth.userId);
    if (!record) return NextResponse.json({ error: "附件不存在" }, { status: 404 });
    const head = await headR2Object(record.r2Key);
    if (!head || head.size == null) return NextResponse.json({ error: "附件上传未完成" }, { status: 409 });
    if (head.size > AGENT_ATTACHMENT_MAX_BYTES) {
      await scheduleAttachmentDeletion(body.attachmentId, body.sessionKey, auth.userId);
      await runAttachmentGcBatch(1);
      return NextResponse.json({ error: "附件实际大小超过 50 MB" }, { status: 413 });
    }
    let attachment;
    try {
      attachment = await markAttachmentReady(body.attachmentId, body.sessionKey, auth.userId, head.size);
    } catch (err) {
      if ((err as { status?: number }).status === 413) {
        await scheduleAttachmentDeletion(body.attachmentId, body.sessionKey, auth.userId);
        await runAttachmentGcBatch(1);
      }
      throw err;
    }
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
    await scheduleAttachmentDeletion(attachmentId, sessionKey, auth.userId);
    await runAttachmentGcBatch(1);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
