// 任务 handler 注册表。重依赖（sharp / pdfjs）一律在 handler 体内 dynamic import：
// next 路由只 import queue，enqueue 快路径不背这些包；worker bundle 才真正装载。

import { TerminalJobError, type JobRow } from "./queue";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";

export type JobHandler = (payload: Record<string, unknown>, job: JobRow) => Promise<Record<string, unknown> | null>;

export interface JobHandlerDef {
  run: JobHandler;
  /** 任务终局后如需唤醒 agent 会话（payload.notifySessionId 在场时），生成插话文本。 */
  steerMessage?: (job: JobRow, ok: boolean) => string;
}

const handlers = new Map<string, JobHandlerDef>();

export function registerJobHandler(kind: string, def: JobHandlerDef): void {
  handlers.set(kind, def);
}

export function getJobHandlerDef(kind: string): JobHandlerDef | null {
  return handlers.get(kind) ?? null;
}

// ── doc_parse：pdf/docx 解析 → IR 落 R2 ──────────────────────────────────────
// payload: { fileId, r2Key, fileSize, fileKind: "pdf"|"docx", fileName?, notifySessionId? }
// 解析类错误（坏文件/超上限）是确定性失败 → 终局；R2 瞬态读错误 → 重试。

registerJobHandler("doc_parse", {
  async run(payload) {
    const fileId = typeof payload.fileId === "string" ? payload.fileId : "";
    const r2Key = typeof payload.r2Key === "string" ? payload.r2Key : "";
    const fileKind = payload.fileKind === "pdf" || payload.fileKind === "docx" ? payload.fileKind : null;
    const fileSize = typeof payload.fileSize === "number" ? payload.fileSize : null;
    if (!fileId || !r2Key || !fileKind) throw new TerminalJobError("doc_parse payload 缺少 fileId / r2Key / fileKind");

    const { r2ByteSource } = await import("@/lib/asset/byte-source");
    const { storeDocIr } = await import("@/lib/doc-extract/ir-store");
    const src = r2ByteSource(r2Key, fileSize);

    if (fileKind === "pdf") {
      const { parsePdf, readAll, PdfParseError, PDF_EXTRACTOR_VERSION } = await import("@/lib/doc-extract/pdf");
      let doc;
      try {
        doc = await parsePdf(await readAll(src));
      } catch (e) {
        if (e instanceof PdfParseError) throw new TerminalJobError(e.message);
        throw e;
      }
      const irKey = await storeDocIr("pdf", fileId, PDF_EXTRACTOR_VERSION, doc);
      return { irKey, pages: doc.stats.pageCount };
    }

    const { parseDocx, DocxParseError, DOCX_EXTRACTOR_VERSION } = await import("@/lib/doc-extract/docx");
    let doc;
    try {
      doc = await parseDocx(src);
    } catch (e) {
      if (e instanceof DocxParseError) throw new TerminalJobError(e.message);
      throw e;
    }
    const irKey = await storeDocIr("docx", fileId, DOCX_EXTRACTOR_VERSION, doc);
    return { irKey, items: doc.items.length };
  },
  steerMessage(job, ok) {
    const name = neutralizeInjectionTags(typeof job.payload.fileName === "string" && job.payload.fileName ? job.payload.fileName : "（未命名）");
    return ok
      ? `【系统通知】文档《${name}》后台解析完成。现在重新调用刚才的 doc_* 工具即可继续。`
      : `【系统通知】文档《${name}》后台解析失败：${job.error ?? "未知错误"}。请把情况告知用户，不要重试。`;
  },
});

// ── image_thumbnail：R2 原图 → sharp 缩略 → 回写 asset_file ──────────────────
// payload: { assetFileId, r2Key, thumbKey }
// 非图像/坏图（sharp 解不开）是确定性失败 → 终局，行保持无缩略图（前端本就容忍）。

registerJobHandler("image_thumbnail", {
  async run(payload) {
    const assetFileId = typeof payload.assetFileId === "string" ? payload.assetFileId : "";
    const r2Key = typeof payload.r2Key === "string" ? payload.r2Key : "";
    const thumbKey = typeof payload.thumbKey === "string" ? payload.thumbKey : "";
    if (!assetFileId || !r2Key || !thumbKey) throw new TerminalJobError("image_thumbnail payload 缺少 assetFileId / r2Key / thumbKey");

    const { getR2Object, putR2Object } = await import("@/lib/r2");
    const obj = await getR2Object(r2Key);
    if (!obj) throw new TerminalJobError("源文件不存在（R2 对象缺失）");
    const sharp = (await import("sharp")).default;
    let thumb: Buffer;
    try {
      thumb = await sharp(obj.body)
        .resize(400, 400, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (e) {
      throw new TerminalJobError(`缩略图生成失败：${e instanceof Error ? e.message : String(e)}`);
    }
    await putR2Object(thumbKey, thumb, "image/webp");
    const { setAssetFileThumbnail } = await import("@/lib/asset/db");
    await setAssetFileThumbnail(assetFileId, thumbKey);
    return { thumbKey };
  },
});
