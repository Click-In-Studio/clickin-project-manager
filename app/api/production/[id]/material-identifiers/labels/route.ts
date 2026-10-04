import type { NextRequest } from "next/server";
import { getSession } from "@/lib/account/session";
import { attachmentContentDisposition } from "@/lib/asset/content-disposition";
import { getProductionPermissionContext } from "@/lib/perm/permission-context-db";
import { toActor } from "@/lib/perm/grant-check";
import { getMaterial } from "@/lib/ops/material-db";
import { getMaterialIdentifierForImage } from "@/lib/ops/material-identifier-db";
import {
  MATERIAL_LABEL_SIZES,
  renderMaterialLabelArchive,
  renderMaterialLabelPrintPage,
  type MaterialLabelEntry,
  type MaterialLabelFormat,
  type MaterialLabelSize,
  type MaterialLabelSymbology,
} from "@/lib/ops/material-label";
import { canManageMaterialIdentifiers } from "@/lib/ops/material-perm";
import { readJsonObject } from "@/lib/request-json";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: productionId } = await ctx.params;
  const session = getSession(req.cookies);
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  const access = await getProductionPermissionContext(session.userId, false, productionId);
  if (!access) return Response.json({ error: "无权访问" }, { status: 403 });
  if (access.isArchived)
    return Response.json({ error: "已归档的项目不可生成码图片" }, { status: 403 });
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const identifierIds = body.identifierIds;
  const symbology = (body.type ?? "qr") as MaterialLabelSymbology;
  const format = (body.format ?? "svg") as MaterialLabelFormat;
  const size = (body.size ?? "medium") as MaterialLabelSize;
  const output = body.output ?? "zip";
  if (!Array.isArray(identifierIds) || identifierIds.length < 1 || identifierIds.length > 100
      || identifierIds.some(id => typeof id !== "string" || !id)
      || new Set(identifierIds).size !== identifierIds.length
      || !(["qr", "code128"] as const).includes(symbology)
      || !(["svg", "png"] as const).includes(format)
      || !(MATERIAL_LABEL_SIZES as readonly string[]).includes(size)
      || (output !== "zip" && output !== "print"))
    return Response.json({ error: "批量标签参数无效" }, { status: 400 });

  const actor = toActor(session, access.permCtx);
  const entries: MaterialLabelEntry[] = [];
  for (const identifierId of identifierIds as string[]) {
    const resolved = await getMaterialIdentifierForImage(productionId, identifierId);
    if (!resolved || resolved.identifier.kind !== "internal_code")
      return Response.json({ identifierId, error: "内部码不存在" }, { status: 404 });
    const material = await getMaterial(resolved.identifier.materialId, productionId);
    if (!material || !await canManageMaterialIdentifiers(actor, productionId, material.id))
      return Response.json({ identifierId, error: "权限不足" }, { status: 403 });
    if (resolved.status !== "valid")
      return Response.json({ identifierId, status: resolved.status, error: resolved.status === "inactive" ? "该码已失效" : "对应实物或批次已不可用" }, { status: 409 });
    entries.push({
      materialName: resolved.materialName,
      materialNumber: resolved.materialNumber,
      internalCode: resolved.identifier.displayValue,
      payload: symbology === "qr"
        ? `${(process.env.APP_BASE_URL ?? req.nextUrl.origin).replace(/\/$/, "")}/api/material-identifiers/scan/${resolved.token}`
        : resolved.identifier.displayValue,
    });
  }

  if (output === "print") {
    const html = await renderMaterialLabelPrintPage({ entries, symbology, size });
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }
  const archive = await renderMaterialLabelArchive({ entries, symbology, format, size });
  const archiveBody = new ArrayBuffer(archive.byteLength);
  new Uint8Array(archiveBody).set(archive);
  return new Response(archiveBody, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentContentDisposition("物料标签.zip"),
      "Cache-Control": "private, no-store",
    },
  });
}
