// 资产上传后置任务（缩略图 + 文档解析预热）——上传路径只入队不干重活。
//
// 2026-09 负载盘点定谳：上传不加大小帽（by design），但同步 sharp 是大问题——
// 大文件直连 R2 后由 heavy-worker 慢慢处理。缩略图异步生成（asset_file 行先落
// NULL，前端本就容忍无缩略图，生成后回写）；docx/pdf 顺手投低优先级解析预热，
// 让 agent 真正读文档时大概率命中 IR 快路径。

import { enqueueJob } from "./queue";
import { thumbnailR2Key } from "@/lib/r2";
import { docParseDedupeKey } from "@/lib/doc-extract/load";

export interface AssetPostProcessInput {
  /** asset_file 行 id（缩略图回写与文档 IR 的键）。 */
  assetFileId: string;
  r2Key: string;
  mimeType: string;
  fileName: string;
  fileSize: number | null;
}

/**
 * best-effort、**永不抛**：调用点在 asset/file 行已落库之后，这里再失败也不能把
 * 已成功的上传打成 500（AI review #455 ①）。缩略图丢了只是没图标（新版本会补）；
 * doc 解析预热丢了有懒轨兜底（load.ts 首读时重新入队），都不值得让上传失败。
 */
export async function enqueueAssetPostProcess(input: AssetPostProcessInput): Promise<void> {
  try {
    if (input.mimeType.startsWith("image/")) {
      await enqueueJob({
        kind: "image_thumbnail",
        dedupeKey: `image_thumbnail:${input.assetFileId}`,
        payload: { assetFileId: input.assetFileId, r2Key: input.r2Key, thumbKey: thumbnailR2Key(input.assetFileId) },
      }).catch((err) => console.error(`[asset-jobs] thumbnail enqueue failed for ${input.assetFileId}:`, err));
    }
    const lower = input.fileName.toLowerCase();
    const fileKind = lower.endsWith(".pdf") ? "pdf" : lower.endsWith(".docx") ? "docx" : null;
    if (fileKind) {
      await enqueueJob({
        kind: "doc_parse",
        dedupeKey: docParseDedupeKey(fileKind, input.assetFileId),
        priority: -1, // 预热让行：有人等的解析先跑
        payload: { fileId: input.assetFileId, r2Key: input.r2Key, fileSize: input.fileSize, fileKind, fileName: input.fileName },
      }).catch((err) => console.error(`[asset-jobs] doc_parse prewarm enqueue failed for ${input.assetFileId}:`, err));
    }
  } catch (err) {
    console.error(`[asset-jobs] post-process enqueue failed for ${input.assetFileId}:`, err);
  }
}
