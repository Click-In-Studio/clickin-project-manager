import { type NextRequest } from "next/server";
import { verifyShareToken } from "@/lib/asset-share-token";
import { getAsset, getLatestAssetFile } from "@/lib/asset-db";
import { getR2Stream } from "@/lib/r2";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const payload = verifyShareToken(token);
  if (!payload) return new Response("链接无效或已过期", { status: 403 });

  const file = await getLatestAssetFile(payload.aid);
  if (!file?.r2Key) return new Response("文件不存在", { status: 404 });

  const range = req.headers.get("range");
  const r2Res = await getR2Stream(file.r2Key, range);
  if (!r2Res) return new Response("文件不存在", { status: 404 });

  const asset = await getAsset(payload.aid);
  const fileName = asset ? (asset.name ?? asset.fileName) : file.r2Key.split("/").pop() ?? "file";

  const headers = new Headers();
  const mimeType = r2Res.headers.get("content-type") ?? "application/octet-stream";
  headers.set("Content-Type", mimeType);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");

  if (payload.dl) {
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
