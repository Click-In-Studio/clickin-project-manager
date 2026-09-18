// 「本页帮助」（#538）：当前 pathname → 手册页。映射表是服务端从 content/manual 的
// frontmatter `routes` 算出来的（lib/help/manual.manualRouteIndex），经 RootLayout 下发；
// 这里只做 pathname → 候选路由键的归一化，与 nav-config / 手册 routes 同一口径：
//   项目内页    → 相对 path（"script"、"events/callsheet"、"admin/roles"、"admin"）
//   项目外页    → 绝对 path（"/my/tasks"、"/account"、"/"）
// 从最具体到最泛依次查，都没有就回手册首页。

const PRODUCTION_RE = /^\/production\/[^/]+(?:\/(.*))?$/;

/** 按具体→泛的顺序给出候选键，第一个命中的就是本页帮助。 */
export function helpRouteCandidates(pathname: string): string[] {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const m = clean.match(PRODUCTION_RE);
  if (m) {
    const rest = m[1] ?? "";
    if (!rest) return [""];
    // 去掉动态段（id 形状的段）：events/ev_123/callsheet → events/callsheet
    const segs = rest.split("/").filter((s) => !looksLikeId(s));
    const out: string[] = [];
    for (let i = segs.length; i >= 1; i--) out.push(segs.slice(0, i).join("/"));
    return out;
  }
  // 项目外：/account?tab=… 这类由调用方传 pathname（不含 query），逐级回退到 "/"
  const segs = clean.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = segs.length; i >= 1; i--) out.push("/" + segs.slice(0, i).join("/"));
  out.push("/");
  return out;
}

/** 动态段判据：uuid、nd_/br_ 等短 id、纯数字、日期。判错的代价只是多试一个候选。 */
function looksLikeId(seg: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)
    || /^[a-z]{1,4}_[0-9a-z]{6,}$/i.test(seg)
    || /^\d+$/.test(seg)
    || /^\d{4}-\d{2}-\d{2}$/.test(seg)
    || /^demo-/.test(seg);
}

/** 给 <Link href> 用：命中 → /help/<slug>，否则 /help。 */
export function helpHrefFor(pathname: string, routeIndex: Record<string, string>): string {
  for (const key of helpRouteCandidates(pathname)) {
    const slug = routeIndex[key];
    if (slug) return `/help/${slug}`;
  }
  return "/help";
}
