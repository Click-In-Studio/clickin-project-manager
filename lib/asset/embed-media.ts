// ─── 嵌入形态支持列表（wiki 正文 ![](/__cm__/asset/<id>) 的渲染 broker）─────────
//
// 语法只有一种（嵌入=引用加 `!`，语法大纲 §3），**形态**按媒体类型分发：
// image → <img>、video → <video>、audio → <audio>，不在列表里的一律降级为
// 文件卡片占位（不猜、不硬渲染）。这张表是渲染端与上传入口（粘贴/拖拽收不收
// 这个文件）共用的唯一判据——两端分叉=「贴得进去渲染不出」。
//
// 长尾（pdf 内嵌翻页、adm/bwf 波形、office 预览等）各有各的坑，按类型逐个
// 立项解决，不在这张基础表里赊账。判型以 mime 前缀为准：这里消费的是
// asset.mime_type（登记值）与 File.type（上传时浏览器判定），与 #85 元数据
// broker 的 magic 判型（sniffDetectedType）是两层——那层管"文件其实是什么"，
// 这层只管"这个声明类型有没有嵌入形态"。

export type EmbedMediaKind = "image" | "video" | "audio";

export function embedMediaKind(mimeType: string | null | undefined): EmbedMediaKind | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return null;
}

/** 上传入口（粘贴/拖拽进正文）收不收：有嵌入形态才收，其余交资产面板管道。 */
export function isEmbeddableUpload(mimeType: string | null | undefined): boolean {
  return embedMediaKind(mimeType) !== null;
}
