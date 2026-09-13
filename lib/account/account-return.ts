/**
 * 个人中心「返回工作区」的目标地址。
 *
 * AppShell 进入 /account 时把当前项目首页写进 ?from=，个人中心据此回到进入前的项目。
 * 这个参数是用户可控的，所以只认 AppShell 会生成的那一种形状（项目首页），别的一律
 * 落回工作区首页——否则 ?from= 就成了可跳往任意地址的开放式重定向。
 */
const PRODUCTION_HOME = /^\/production\/[^/?#]+\/?$/;

/** 工作区首页：`from` 缺失或不合法时的兜底。 */
export const WORKSPACE_HOME = "/";

/**
 * sessionStorage 键。`from` 只在首次进入个人中心时挂在 URL 上：绑定飞书要跳出去再回来、
 * 绑定/合并回调又会 router.replace 掉整串 query，之后 URL 上就没有它了。按标签页存一份，
 * 「返回工作区」才不会在绕一圈之后退化成回首页。
 */
export const ACCOUNT_RETURN_KEY = "account:returnHref";

/** 合法则返回去掉尾斜杠的规范形式，否则 null（调用方自行决定兜底）。 */
export function normalizeAccountReturnHref(raw: string | null | undefined): string | null {
  if (!raw || !PRODUCTION_HOME.test(raw)) return null;
  return raw.replace(/\/$/, "");
}
