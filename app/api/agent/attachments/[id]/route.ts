import { type NextRequest } from "next/server";
import { requireOwnership, requireUser } from "@/lib/agent/chat/http";
import { getReadyAttachmentForSession } from "@/lib/agent/attachment-db";
import { productionIdOfSessionKey } from "@/lib/agent/tools/session-identity-parse";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { requireProductionFeature } from "@/lib/account/plan";
import { getR2Stream } from "@/lib/r2";

/** 会话附件预览/下载始终经本站鉴权代理，不向浏览器持久化 R2 签名地址。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireUser(req.cookies);
  if (auth instanceof Response) return auth;
  const sessionKey = req.nextUrl.searchParams.get("sessionKey");
  if (!sessionKey) return new Response("缺少 sessionKey", { status: 400 });
  const denied = requireOwnership(sessionKey, auth.userId);
  if (denied) return denied;
  const productionId = productionIdOfSessionKey(sessionKey);
  if (productionId) {
    // 历史会话所有者若已退出制作，也不能继续通过旧聊天读取附件。
    const access = await getProductionPermissionContext(auth.userId, false, productionId);
    if (!access) return new Response("你不是该制作的成员", { status: 403 });
    const featureDeny = await requireProductionFeature(productionId, "ai");
    if (featureDeny) return featureDeny;
  }
  const { id } = await ctx.params;
  const attachment = await getReadyAttachmentForSession(id, sessionKey, auth.userId);
  if (!attachment) return new Response("附件不存在或不可读", { status: 404 });
  const source = await getR2Stream(attachment.r2Key, req.headers.get("range"));
  if (!source) return new Response("附件对象不存在", { status: 404 });
  const download = req.nextUrl.searchParams.get("download") === "1";
  const safeName = attachment.fileName.replace(/[\r\n"]/g, "_");
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_");
  const headers = new Headers({
    "Content-Type": attachment.mimeType,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  });
  for (const name of ["content-range", "content-length"]) {
    const value = source.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(source.body, { status: req.headers.has("range") ? 206 : 200, headers });
}
