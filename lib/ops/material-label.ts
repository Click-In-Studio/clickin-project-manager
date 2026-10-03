import bwipjs from "bwip-js/node";
import { strToU8, zipSync } from "fflate";

export const MATERIAL_LABEL_SIZES = ["small", "medium", "large"] as const;
export type MaterialLabelSize = typeof MATERIAL_LABEL_SIZES[number];
export type MaterialLabelSymbology = "qr" | "code128";
export type MaterialLabelFormat = "svg" | "png";

const SIZE_OPTIONS: Record<MaterialLabelSize, { scale: number; height: number; padding: number }> = {
  small: { scale: 2, height: 10, padding: 4 },
  medium: { scale: 3, height: 14, padding: 8 },
  large: { scale: 4, height: 18, padding: 12 },
};

export async function renderMaterialCodeImage(params: {
  symbology: MaterialLabelSymbology;
  format: MaterialLabelFormat;
  payload: string;
  size: MaterialLabelSize;
}): Promise<{ body: string | Buffer; contentType: string }> {
  const preset = SIZE_OPTIONS[params.size];
  const options: Parameters<typeof bwipjs.toSVG>[0] = params.symbology === "qr"
    ? {
      bcid: "qrcode", text: params.payload, scale: preset.scale,
        padding: preset.padding,
      }
    : {
        bcid: "code128", text: params.payload, scale: preset.scale,
        height: preset.height, padding: preset.padding,
        includetext: true, textxalign: "center" as const,
      };
  if (params.format === "svg")
    return { body: bwipjs.toSVG(options), contentType: "image/svg+xml; charset=utf-8" };
  const body = await new Promise<Buffer>((resolve, reject) => {
    bwipjs.toBuffer(options, (error, png) => error ? reject(error) : resolve(png));
  });
  return { body, contentType: "image/png" };
}

export type MaterialLabelEntry = {
  materialName: string;
  materialNumber: string;
  internalCode: string;
  payload: string;
};

function labelFileStem(entry: MaterialLabelEntry, symbology: MaterialLabelSymbology) {
  const suffix = symbology === "qr" ? "QR" : "条码";
  return `${entry.materialNumber}-${entry.internalCode}-${suffix}`.replace(/[\\/:*?"<>|]/g, "_");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export async function renderMaterialLabelArchive(params: {
  entries: MaterialLabelEntry[];
  symbology: MaterialLabelSymbology;
  format: MaterialLabelFormat;
  size: MaterialLabelSize;
}): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of params.entries) {
    const image = await renderMaterialCodeImage({
      symbology: params.symbology,
      format: params.format,
      payload: entry.payload,
      size: params.size,
    });
    files[`${labelFileStem(entry, params.symbology)}.${params.format}`] =
      typeof image.body === "string" ? strToU8(image.body) : new Uint8Array(image.body);
  }
  return zipSync(files, { level: 6 });
}

export async function renderMaterialLabelPrintPage(params: {
  entries: MaterialLabelEntry[];
  symbology: MaterialLabelSymbology;
  size: MaterialLabelSize;
}): Promise<string> {
  const labels = await Promise.all(params.entries.map(async entry => {
    const image = await renderMaterialCodeImage({
      symbology: params.symbology,
      format: "svg",
      payload: entry.payload,
      size: params.size,
    });
    return `<article class="label">${image.body}<div class="number">${escapeHtml(entry.internalCode)}</div><div>${escapeHtml(entry.materialNumber)} · ${escapeHtml(entry.materialName)}</div></article>`;
  }));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>物料标签</title><style>@page{margin:10mm}body{margin:0;font:12px system-ui,sans-serif}.sheet{display:flex;flex-wrap:wrap;gap:8mm}.label{box-sizing:border-box;break-inside:avoid;text-align:center;padding:4mm;border:1px dashed #aaa}.label svg{display:block;max-width:100%;height:auto;margin:auto}.number{font-weight:700;font-size:14px;margin-top:2mm}@media print{.label{border:0}}</style></head><body><main class="sheet">${labels.join("")}</main></body></html>`;
}
