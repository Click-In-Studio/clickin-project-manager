import { getR2Stream } from "@/lib/r2";
import { preflightAttachment } from "@/lib/mmp/attachment-preflight";
import { neutralizeInjectionTags } from "../agent-injection-safety";
import { attachmentDocRead, attachmentFileOcr } from "./doc-tools";
import type { MediaResource } from "../runtime/model-media";

export interface MediaReadOptions {
  window?: import("./doc-window").DocWindow;
  mode?: "outline" | "read" | "search" | "ocr";
  ranges?: Array<{ from: number; to: number }>;
  query?: string;
  pages?: number[];
  tier?: "fast" | "full";
  limit?: number;
}

type TextReadResult = { text: string; complete: boolean; details?: import("./result-attachment").SavedTextDetails };
function parsedResult(value: string | import("./result-attachment").SavedTextToolResult): TextReadResult {
  return typeof value === "string" ? { text: value, complete: false }
    : { text: value.content.filter(part => part.type === "text").map(part => part.text).join("\n"), complete: false, details: value.details };
}
/** 非原生读取共用现有文档/MMP 能力；完整文本与概览、片段、预检严格区分。 */
export async function readResourceText(resource: MediaResource, options: MediaReadOptions,
  context: { userId: string; productionId: string | null; sessionId: string | null; runId?: string; toolCallId?: string; signal?: AbortSignal },
): Promise<TextReadResult> {
  const lower = resource.fileName.toLowerCase();
  const file = { fileId: resource.id, r2Key: resource.r2Key, fileSize: resource.fileSize, fileName: resource.fileName };
  if (lower.endsWith(".docx") || lower.endsWith(".pdf")) {
    const text = options.mode === "ocr"
      ? await attachmentFileOcr(context.userId, context.productionId, file, resource.mimeType, options.pages ?? [1], {
        tier: options.tier, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, signal: context.signal,
      })
      : await attachmentDocRead(file, { mode: options.mode === "search" ? "search" : options.mode === "read" && (options.ranges?.length || options.window) ? "read" : "outline",
        ranges: options.ranges, window: options.window, query: options.query, limit: options.limit }, { sessionId: context.sessionId });
    return parsedResult(text);
  }
  const mediaKind = resource.mediaKind ?? /^(audio|image|video)\//.exec(resource.mimeType)?.[1];
  if (mediaKind === "image" && options.mode === "ocr") return parsedResult(
    await attachmentFileOcr(context.userId, context.productionId, file, resource.mimeType, options.pages ?? [1], {
      tier: options.tier, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, signal: context.signal,
    }));
  if (mediaKind) {
    const outcome = await preflightAttachment({ attachmentId: resource.id, mediaKind: resource.mediaKind,
      mimeType: resource.mimeType, r2Key: resource.r2Key }, {
      signal: context.signal, usage: { userId: context.userId, productionId: context.productionId },
    });
    return { text: neutralizeInjectionTags(outcome.contextText) + "\n以上为 MMP 解析证据，当前模型未原生读取该原件。", complete: false };
  }
  if (resource.mimeType.startsWith("text/") || /\.(md|txt|csv|json|xml|yaml|yml|log)$/.test(lower)) {
    if (resource.fileSize > 50 * 1024 * 1024) return { text: "纯文本超过文件读取上限 50 MiB，请缩小文件范围。", complete: false };
    const ranges = options.ranges;
    const collectFull = options.mode === "search" || !!options.window;
    const all: string[] = [];
    const validRanges = !ranges?.length || ranges.every(({ from, to }) => Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from)
      && ranges.reduce((sum, range) => sum + range.to - range.from, 0) <= 80_000;
    const windows = validRanges ? ranges?.length ? ranges : [{ from: 0, to: 80_000 }] : [];
    const selected = windows.map(() => [] as string[]);
    const response = await getR2Stream(resource.r2Key);
    if (!response?.body) return { text: "原件不存在，无法读取。", complete: false };
    let length = 0, bytes = 0;
    const collect = (text: string) => {
      if (collectFull) all.push(text);
      const end = length + text.length;
      windows.forEach(({ from, to }, index) => {
        const start = Math.max(from, length), stop = Math.min(to, end);
        if (stop > start) selected[index].push(text.slice(start - length, stop - length).replace(/\u0000/g, "�"));
      });
      length = end;
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    try {
      while (true) {
        context.signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 50 * 1024 * 1024) throw new Error("纯文本实际大小超过 50 MiB");
        collect(decoder.decode(chunk.value, { stream: true }));
      }
      collect(decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (collectFull) {
      const { formatTextWindow, searchText } = await import("./text-window");
      const full = all.join("");
      const rendered = options.mode === "search" ? searchText(full, options.query ?? "", options.limit, options.window?.offset)
        : formatTextWindow(full, options.window);
      return { text: neutralizeInjectionTags(`《${resource.fileName}》\n${rendered}`), complete: options.mode !== "search" && (options.window?.offset ?? 0) === 0 && full.length <= (options.window?.length ?? 8000) };
    }
    if (ranges?.length) {
      if (!validRanges || ranges.some(({ to }) => to > length)) {
        return { text: `文本共有 ${length} 个字符；区间需满足 0 ≤ from < to ≤ 总字符数，单次最多读取 80,000 字符。`, complete: false };
      }
      return { text: neutralizeInjectionTags(`《${resource.fileName}》共 ${length} 字符；零起始区间 [from,to)：\n`
        + ranges.map(({ from, to }, index) => `[${from},${to})\n${selected[index].join("")}`).join("\n")), complete: ranges.some(({ from, to }) => from === 0 && to === length) };
    }
    return { text: neutralizeInjectionTags(`《${resource.fileName}》共 ${length} 字符：\n` + selected[0].join("") + (length > 80_000
      ? "\n…（已截断；可用 mode=read + ranges 按零起始字符区间继续回查）" : "")), complete: length <= 80_000 };
  }
  return { text: neutralizeInjectionTags(`《${resource.fileName}》（${resource.mimeType}）原件仍保留，但当前没有适合该格式的读取器。`), complete: false };
}
