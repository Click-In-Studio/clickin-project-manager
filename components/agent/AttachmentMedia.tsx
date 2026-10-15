"use client";

import { useState } from "react";

/** 内联呈现失败只影响预览；下载、Agent 处理和转存继续使用同一附件。 */
export function AttachmentMedia({ attachment, sessionKey, onPreview }: {
  attachment: { id: string; fileName: string; mimeType: string; status?: string };
  sessionKey: string;
  onPreview: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (attachment.status && attachment.status !== "ready") return null;
  const url = `/api/agent/attachments/${encodeURIComponent(attachment.id)}?sessionKey=${encodeURIComponent(sessionKey)}`;
  const image = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].includes(attachment.mimeType);
  const audio = attachment.mimeType.startsWith("audio/");
  return <div className="min-w-0 max-w-full">
    {image && !failed && <button type="button" className="mb-1 block max-w-full" onClick={onPreview} aria-label={`预览 ${attachment.fileName}`}>
      <img src={url} alt={attachment.fileName} className="max-h-72 max-w-full rounded object-contain" onError={() => setFailed(true)} />
    </button>}
    {audio && !failed && <audio controls preload="metadata" className="mb-1 block max-w-full" aria-label={`播放 ${attachment.fileName}`} onError={() => setFailed(true)}>
      <source src={url} type={attachment.mimeType} onError={() => setFailed(true)} />
    </audio>}
    {(failed || attachment.mimeType === "image/tiff") && <p className="mb-1">当前浏览器无法预览此文件，可下载后打开。</p>}
    <a href={`${url}&download=1`} className="inline-block underline" aria-label={`下载 ${attachment.fileName}`}>下载</a>
  </div>;
}
