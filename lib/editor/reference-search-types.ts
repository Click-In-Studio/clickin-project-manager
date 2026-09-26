// Slash「引用… / 嵌入素材」二级面板的客户端协议（#692）。
// 零 node 依赖：编辑器组件与 reference-search 路由共用。

import type { ContentMentionKind } from "./mention-types";

export const REFERENCE_SEARCH_KINDS = ["wiki", "asset", "scene", "cue"] as const;
export type ReferenceSearchKind = (typeof REFERENCE_SEARCH_KINDS)[number];

export type ReferenceSearchResult = {
  kind: Extract<ContentMentionKind, ReferenceSearchKind>;
  id: string;
  label: string;
  description?: string;
  /** 素材结果专用；「嵌入素材」据此只展示有嵌入形态的文件。 */
  mimeType?: string | null;
};

export function isReferenceSearchKind(value: unknown): value is ReferenceSearchKind {
  return typeof value === "string"
    && (REFERENCE_SEARCH_KINDS as readonly string[]).includes(value);
}
