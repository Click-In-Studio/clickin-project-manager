import { type NextRequest } from "next/server";
import { getAssetShareLinkAccess, SHARE_SESSION_COOKIE, touchAssetShareSession } from "@/lib/asset/share-link-db";
import { getAsset, getLatestAssetFile } from "@/lib/asset/db";
import { getR2Stream } from "@/lib/r2";
import { isPolicyOn } from "@/lib/perm/policy-db";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const access = await getAssetShareLinkAccess(token, req.cookies.get(SHARE_SESSION_COOKIE)?.value);
  if (access.kind !== "valid") return new Response("链接无效或已过期", { status: 403 });

  // 每次取流都兑现链接行；撤销、到期、单次会话超时与项目总开关即时生效。
  if (!await isPolicyOn(access.link.productionId, "policy.share_token_enabled")) {
    return new Response("链接无效或已过期", { status: 403 });
  }
  await touchAssetShareSession(access.link);

  // asset 在碰 R2 前查，避免无效链接产生对象存储读取与存在性探测。
  const asset = await getAsset(access.link.assetId);
  if (!asset || asset.productionId !== access.link.productionId)
    return new Response("文件不存在", { status: 404 });

  const file = await getLatestAssetFile(access.link.assetId);
  if (!file?.r2Key) return new Response("文件不存在", { status: 404 });

  const range = req.headers.get("range");
  const r2Res = await getR2Stream(file.r2Key, range);
  if (!r2Res) return new Response("文件不存在", { status: 404 });

  const fileName = asset.name ?? asset.fileName;

  const headers = new Headers();
  const mimeType = r2Res.headers.get("content-type") ?? "application/octet-stream";
  headers.set("Content-Type", mimeType);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");

  if (access.link.allowDownload) {
    headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
  } else {
    headers.set("Content-Disposition", "inline");
  }

  const contentRange = r2Res.headers.get("content-range");
  if (contentRange) headers.set("Content-Range", contentRange);
  const contentLength = r2Res.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);

  return new Response(r2Res.body, { status: range ? 206 : 200, headers });
}
