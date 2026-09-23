/**
 * 路由骨架屏上「正在打开「××」…」的页面名（#652）。
 *
 * 只是把 pathname 翻成侧栏 / 菜单里用户见过的那个词，口径与 nav-config 一致；
 * 没收录的路径返回 null，骨架退回不带名字的「正在打开…」。零 node 依赖，可进客户端包。
 */
import { ADMIN_NAV_GROUPS, CREATION_NAV, OVERVIEW_NAV, PRODUCTION_NAV } from "@/components/shell/app-shell/nav-config";

/** 项目内首段 → 页面名。侧栏三组之外的页面按各自 metadata.title 补。 */
const PRODUCTION_SEGMENT_TITLES: Record<string, string> = {
  "": "我的工作",
  notifications: "我的通知",
  "access-requests": "资源申请",
  announcements: "项目公告",
  characters: "构作",
  cuelists: "Cue 表设置",
  "import-script": "导入剧本内容",
  "import-scenes": "导入章节信息",
  admin: "配置中心",
  ...Object.fromEntries([...CREATION_NAV, ...PRODUCTION_NAV].map((n) => [n.path, n.label])),
};

/** 项目外绝对路径 → 页面名。 */
const MY_PATH_TITLES: Record<string, string> = {
  "/": "我的工作",
  "/my/projects": "我的项目",
  ...Object.fromEntries(OVERVIEW_NAV.map((n) => [n.path, n.label])),
};

const ADMIN_TITLES: Record<string, string> = Object.fromEntries(
  ADMIN_NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.path).map((i) => [i.path, i.label]),
);

export function pageTitleFor(pathname: string): string | null {
  if (!pathname) return null;
  const clean = pathname.replace(/\/+$/, "") || "/";
  const m = clean.match(/^\/production\/[^/]+(?:\/(.*))?$/);
  if (m) {
    const segs = (m[1] ?? "").split("/");
    const head = segs[0] ?? "";
    if (head === "admin" && segs[1] && ADMIN_TITLES[segs[1]]) return ADMIN_TITLES[segs[1]];
    return PRODUCTION_SEGMENT_TITLES[head] ?? null;
  }
  const segs = clean.split("/").filter(Boolean);
  // /my/tasks/<id> 这类子页归到父页名
  for (let i = segs.length; i >= 1; i--) {
    const hit = MY_PATH_TITLES["/" + segs.slice(0, i).join("/")];
    if (hit) return hit;
  }
  return clean === "/" ? MY_PATH_TITLES["/"] : null;
}
