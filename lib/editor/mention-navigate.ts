// 引用 chip 的「打开」（点击 chip 与 chip 悬浮条上的「打开」共用）。
//
// wiki 直跳文档页；其余 kind 经 mention-resolve 取 url——它按观看者权限与在用
// 版本算落点，客户端不自己拼剧本域 URL。
//
// 零 node 依赖：客户端组件直接 import。
import { BASE_PATH } from "@/lib/base-path";
import type { ContentMentionAttrs } from "./mention-types";

export async function navigateToMention(productionId: string, attrs: ContentMentionAttrs): Promise<void> {
  const { kind, id, aux, versionId, displayMode } = attrs;
  if (kind === "wiki") {
    window.location.assign(`${BASE_PATH}/production/${productionId}/wiki/${id}`);
    return;
  }
  try {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/mention-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mentions: [{ kind, displayMode, id, aux, versionId }] }),
    });
    if (!res.ok) return;
    const data = await res.json() as { urls: (string | null)[] };
    if (data.urls?.[0]) window.location.assign(`${BASE_PATH}${data.urls[0]}`);
  } catch { /* 解析失败不跳 */ }
}
