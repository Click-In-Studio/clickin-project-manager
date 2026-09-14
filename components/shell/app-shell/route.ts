import { isWikiId } from "@/lib/wiki/id";

export function extractProductionId(pathname: string): string | null {
  const m = pathname.match(/^\/production\/([^/]+)/);
  return m ? m[1] : null;
}

/** 仅匹配文档详情页 /production/{id}/wiki/{wikiId}——不匹配文档库根页
 *  /production/{id}/wiki（那个没有具体文档可附带）。驱动 AI popout 的
 *  「附带当前文档」chip。 */
export function extractCurrentWikiId(pathname: string, productionId: string): string | null {
  // wiki 文档有两个入口路由：「文档」模块与「构作 · 灵感文档」工作区。两边都得认，
  // 否则在工作区里开着文档时 AI 助手拿不到当前文档上下文。
  const m = pathname.match(
    new RegExp(`^/production/${productionId}/(?:wiki|dramaturgy/inspiration)/([^/]+)`),
  );
  // 这个段还会是 `nd_` 壳节点 id（软链接 / 资产节点就地渲染，#358 → #420）：
  // 那不是文档，chip 无从附带，拿去 fetch 只会给后端送一发 uuid 非法输入（#476）。
  return m && isWikiId(m[1]) ? m[1] : null;
}

/** 仅匹配资产详情/预览页 /production/{id}/assets/{assetId}[/preview]——不匹配
 *  资产列表根页。驱动 AI popout 的「附带当前文件」chip（#47 文档解读入口）。 */
export function extractCurrentAssetId(pathname: string, productionId: string): string | null {
  const m = pathname.match(new RegExp(`^/production/${productionId}/assets/([^/]+)`));
  return m ? m[1] : null;
}

export function extractModule(pathname: string, productionId: string): string {
  const base = `/production/${productionId}`;
  if (pathname === base || pathname === base + "/") return "";
  const rest = pathname.slice(base.length + 1);
  const first = rest.split("/")[0];
  if (first === "events") {
    if (rest.includes("/reqs/")) return "tasks";
    if (rest.includes("/reports/")) return "reports";
  }
  return first;
}

export function extractAdminModule(pathname: string, productionId: string): string {
  const base = `/production/${productionId}/admin`;
  if (pathname === base || pathname === base + "/") return "";
  const rest = pathname.slice(base.length + 1);
  return rest.split("/")[0];
}
