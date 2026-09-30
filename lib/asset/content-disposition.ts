/**
 * 下载文件名同时提供 ASCII fallback 与 RFC 5987 UTF-8 名称。
 * R2 key 只负责对象寻址，不能再作为用户看到的文件名。
 */
export function attachmentContentDisposition(fileName: string): string {
  const safeName = fileName.replace(/[\u0000-\u001f\u007f/\\]/g, "_") || "download";
  const fallback = safeName.replace(/[^\x20-\x7e]|["%]/g, "_");
  const encoded = encodeURIComponent(safeName)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
