import { getWiki } from "@/lib/wiki/content";
import { canViewWiki } from "@/lib/wiki/perm";
import { extractWikiOutline } from "@/lib/wiki/outline-types";
import { neutralizeInjectionTags } from "@/lib/agent/agent-injection-safety";
import { resolveProductionActor, DENIED_NOT_MEMBER } from "./production-tools";
import { lineWindow, lineLocator, textMatches, fuzzyLineMatches, type LineRange } from "./wiki-text";

export type WikiSearchOptions = LineRange & {
  wikiId?: string;
  matchMode?: "literal" | "regex" | "fuzzy";
  flags?: string;
  contextLines?: number;
  limit?: number;
};

export function sectionPath(body: string, offset: number): string[] {
  const path: Array<{ level: number; text: string }> = [];
  for (const item of extractWikiOutline(body)) {
    if (item.offset > offset) break;
    while (path.length && path[path.length - 1].level >= item.level) path.pop();
    path.push(item);
  }
  return path.map(item => item.text);
}

export async function wikiSearchDocument(userId: string, productionId: string, query: string, options: WikiSearchOptions): Promise<string> {
  const resolved = await resolveProductionActor(userId, productionId);
  if (!resolved) return DENIED_NOT_MEMBER;
  if (!options.wikiId || !await canViewWiki(resolved.actor, productionId, options.wikiId)) return "权限被拒绝：你看不到这篇文档。";
  const doc = await getWiki(options.wikiId, productionId);
  if (!doc) return "没有找到该文档。";
  try {
    const window = lineWindow(doc.body, options);
    const context = options.contextLines ?? 2;
    const limit = options.limit ?? 20;
    if (!Number.isInteger(context) || context < 0 || context > 10) throw new Error("contextLines 需为 0–10。");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit 需为 1–100。");
    const mode = options.matchMode ?? "literal";
    if (mode === "fuzzy" && options.flags) throw new Error("模糊搜索不接受正则 flags。");
    const locate = lineLocator(window.text);
    const windowLines = window.text.split("\n");
    const hits = mode === "fuzzy"
      ? fuzzyLineMatches(window.text, query).map(m => ({ startLine: window.startLine + m.index, endLine: window.startLine + m.index, score: m.score, matchedText: windowLines[m.index].slice(0, 400) }))
      : textMatches(window.text, query, "", mode, options.flags).map(m => ({
        startLine: window.startLine + locate(m.start) - 1,
        endLine: window.startLine + locate(m.end - 1) - 1,
        matchedText: m.text.slice(0, 400),
      }));
    const lines = doc.body.split("\n");
    const matches = hits.slice(0, limit).map(hit => {
      const startLine = Math.max(1, hit.startLine - context);
      const endLine = Math.min(lines.length, hit.endLine + context);
      const content = lines.slice(startLine - 1, endLine).join("\n");
      return { ...hit, contextStartLine: startLine, contextEndLine: endLine,
        content: content.slice(0, 1200), truncated: content.length > 1200 };
    });
    return neutralizeInjectionTags(JSON.stringify({
      wikiId: doc.id, title: doc.title, totalLines: lines.length, matchMode: mode,
      searchedRange: { startLine: window.startLine, endLine: window.endLine },
      totalMatches: hits.length, truncated: hits.length > limit, matches,
      ...(mode === "fuzzy" ? { note: "模糊搜索只定位候选；修改前请读取原文，用 literal 或 regex patch。" } : {}),
    }));
  } catch (error) {
    return neutralizeInjectionTags(`搜索失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
