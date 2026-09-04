import { type NextRequest } from "next/server";
import { verifyShareToken } from "@/lib/asset/share-token";
import { getAsset, getLatestAssetFile } from "@/lib/asset/db";
import { getR2Stream } from "@/lib/r2";
import { isPolicyOn } from "@/lib/policy-db";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const payload = verifyShareToken(token);
  if (!payload) return new Response("链接无效或已过期", { status: 403 });

  // asset 提前到取流之前查：出口判定必须在碰 R2 之前，否则关掉出口后仍会产生
  // 一次对象存储读取（既是流量也是信息泄漏——存在性可被探测）。
  const asset = await getAsset(payload.aid);
  if (!asset) return new Response("文件不存在", { status: 404 });

  // #236 出口开关：**兑现端也要读**。令牌是签名载荷不是库里的行，撤不掉；
  // 只改发放端等于「关出口」半截生效——已发出去的链接照样能用。两处同读，
  // 关掉即刻停发新链接 + 已发链接同时失效（形状 C 天然追溯）。
  if (!await isPolicyOn(asset.productionId, "policy.share_token_enabled")) {
    return new Response("链接无效或已过期", { status: 403 });
  }

  const file = await getLatestAssetFile(payload.aid);
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
