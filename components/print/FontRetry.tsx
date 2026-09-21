"use client";

import { useEffect } from "react";
import { installFontRetry } from "./font-retry";

/**
 * 全站挂一份字体片重试（#594）：不渲染任何东西，只在挂载后把 installFontRetry
 * 接到 document.fonts 上。放 layout 而不是剧本页，是因为三个面在剧本编辑器、
 * 打印预览、知识库都在用。
 */
export default function FontRetry() {
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts || typeof FontFace === "undefined") return;
    return installFontRetry(fonts);
  }, []);
  return null;
}
