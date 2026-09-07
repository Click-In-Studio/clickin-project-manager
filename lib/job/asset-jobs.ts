// 资产上传后置任务（缩略图 + 文档解析预热）——上传路径只入队不干重活。
//
// 2026-09 负载盘点定谳：上传不加大小帽（by design），但同步 sharp 是大问题——
// 大文件直连 R2 后由 heavy-worker 慢慢处理。缩略图异步生成（asset_file 行先落
// NULL，前端本就容忍无缩略图，生成后回写）；docx/pdf 顺手投低优先级解析预热，
// 让 agent 真正读文档时大概率命中 IR 快路径。

import { enqueueJob } from "./queue";
import { thumbnailR2Key } from "@/lib/r2";

export interface AssetPostProcessInput {
  /** asset_file 行 id（缩略图回写与文档 IR 的键）。 */
  assetFileId: string;
  r2Key: string;
  mimeType: string;
  fileName: string;
  fileSize: number | null;
}

/** best-effort：入队失败不打断上传（缩略图/预热都可事后补）。 */
export async function enqueueAssetPostProcess(input: AssetPostProcessInput): Promise<void> {
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
    const { docParseDedupeKey } = await import("@/lib/doc-extract/load");
    await enqueueJob({
      kind: "doc_parse",
      dedupeKey: docParseDedupeKey(fileKind, input.assetFileId),
      priority: -1, // 预热让行：有人等的解析先跑
      payload: { fileId: input.assetFileId, r2Key: input.r2Key, fileSize: input.fileSize, fileKind, fileName: input.fileName },
    }).catch((err) => console.error(`[asset-jobs] doc_parse prewarm enqueue failed for ${input.assetFileId}:`, err));
  }
}
