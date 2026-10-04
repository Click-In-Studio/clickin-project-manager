import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { attachmentContentDisposition } from "@/lib/asset/content-disposition";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import { getMaterial } from "@/lib/ops/material-db";
import { canPrintMaterialLabels } from "@/lib/ops/material-perm";
import { getMaterialIdentifierForImage } from "@/lib/ops/material-identifier-db";
import {
  MATERIAL_LABEL_SIZES,
  renderMaterialCodeImage,
  type MaterialLabelFormat,
  type MaterialLabelSize,
  type MaterialLabelSymbology,
} from "@/lib/ops/material-label";

type Ctx = { params: Promise<{ id: string; identifierId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id: productionId, identifierId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  const resolved = await getMaterialIdentifierForImage(productionId, identifierId);
  if (!resolved) return Response.json({ error: "标识不存在" }, { status: 404 });
  const material = await getMaterial(resolved.identifier.materialId, productionId);
  if (!material) return Response.json({ error: "物料不存在" }, { status: 404 });
  if (!await canPrintMaterialLabels(toActor(session, access.permCtx), productionId, material))
    return Response.json({ error: "权限不足" }, { status: 403 });
  if (resolved.identifier.kind !== "internal_code")
    return Response.json({ error: "只有内部实物或批次码可以生成标签" }, { status: 400 });
  if (resolved.status === "inactive")
    return Response.json({ status: "inactive", error: "该码已失效" }, { status: 409 });
  if (resolved.status === "unavailable")
    return Response.json({ status: "unavailable", error: "对应实物或批次已不可用" }, { status: 409 });

  const query = req.nextUrl.searchParams;
  const symbology = (query.get("type") ?? "qr") as MaterialLabelSymbology;
  const format = (query.get("format") ?? "svg") as MaterialLabelFormat;
  const size = (query.get("size") ?? "medium") as MaterialLabelSize;
  if (!(["qr", "code128"] as const).includes(symbology)
      || !(["svg", "png"] as const).includes(format)
      || !(MATERIAL_LABEL_SIZES as readonly string[]).includes(size))
    return Response.json({ error: "码图片参数无效" }, { status: 400 });

  const appOrigin = (process.env.APP_BASE_URL ?? req.nextUrl.origin).replace(/\/$/, "");
  const payload = symbology === "qr"
    ? `${appOrigin}/api/material-identifiers/scan/${resolved.token}`
    : resolved.identifier.displayValue;
  const image = await renderMaterialCodeImage({ symbology, format, payload, size });
  const headers = new Headers({ "Content-Type": image.contentType, "Cache-Control": "private, no-store" });
  if (query.get("download") === "1") {
    const suffix = symbology === "qr" ? "QR" : "条码";
    headers.set("Content-Disposition", attachmentContentDisposition(
      `${resolved.materialNumber}-${resolved.identifier.displayValue}-${suffix}.${format}`,
    ));
  } else {
    headers.set("Content-Disposition", "inline");
  }
  const body = typeof image.body === "string" ? image.body : new Uint8Array(image.body);
  return new Response(body, { headers });
}
