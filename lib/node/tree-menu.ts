import type { NodeEntry } from "./db";

// 文档树 ⋯ 菜单的项表（#511）。
//
// 原则：四 kind 同一套项、同一顺序；某 kind 不支持的**灰掉并给原因**，不按 kind
// 条件渲染让它消失——菜单项忽隐忽现，用户既学不会心智模型，也分不清"没权限"和
// "这类东西不支持"。条件性只留给同一项换文案（link 的「删除」叫「移除链接」）。
//
// 这里给的 disabledReason 只是 UI 灰化口径，权限权威永远在服务端各路由的门；
// 树上拿不到逐节点的 edit 判定（与「移动到…」一样），能不能改由服务端 403 说了算。

export type TreeMenuKey = "rename" | "resetTitle" | "duplicate" | "move" | "link" | "delete";

export type TreeMenuItem = {
  key: TreeMenuKey;
  label: string;
  /** 红色危险项。 */
  danger?: boolean;
  /** 有值＝灰掉，值即 tooltip 里给用户看的原因。 */
  disabledReason?: string;
};

export type AssetTreeActions = Record<string, { rename: boolean; delete: boolean }>;

export type TreeMenuCtx = {
  /** node:wiki/*@create——新建/链接/副本的粗门。 */
  canCreate: boolean;
  /** 服务端按 meta@edit / *@delete 分别查出的资产实例权限。 */
  assetActions?: AssetTreeActions;
};

export const TREE_MENU_ORDER: readonly TreeMenuKey[] =
  ["rename", "resetTitle", "duplicate", "move", "link", "delete"];

export function treeMenuItems(it: NodeEntry, ctx: TreeMenuCtx): TreeMenuItem[] {
  const assetActions = it.assetId ? ctx.assetActions?.[it.assetId] : undefined;

  const rename: TreeMenuItem = { key: "rename", label: "重命名" };
  if (it.kind === "folder") rename.disabledReason = "目录改名暂未开放";
  else if (it.kind === "asset" && !assetActions?.rename) rename.disabledReason = "没有重命名该资产的权限";

  const resetTitle: TreeMenuItem = { key: "resetTitle", label: "改回目标标题" };
  if (it.kind !== "link") resetTitle.disabledReason = "仅链接可用：链接可以有自己的别名";
  else if (it.title === null) resetTitle.disabledReason = "当前已跟随目标标题";

  const duplicate: TreeMenuItem = { key: "duplicate", label: "创建副本" };
  if (it.kind === "asset") duplicate.disabledReason = "资产不支持创建副本";
  else if (it.kind === "link") duplicate.disabledReason = "链接不支持创建副本；要在别处再放一份请用「链接到…」";
  else if (it.kind === "folder") duplicate.disabledReason = "目录不支持创建副本";
  else if (!ctx.canCreate) duplicate.disabledReason = "无新建文档权限";

  const move: TreeMenuItem = { key: "move", label: "移动到…" };

  const link: TreeMenuItem = { key: "link", label: "链接到…" };
  if (it.kind === "link") link.disabledReason = "链接不能再被链接";
  else if (it.kind === "folder") link.disabledReason = "目录不能被链接";
  else if (!ctx.canCreate) link.disabledReason = "无新建文档权限";

  const del: TreeMenuItem = { key: "delete", label: it.kind === "link" ? "移除链接" : "删除", danger: true };
  if (it.isAnchor) del.disabledReason = "系统目录，不可删除";
  else if (it.kind === "folder") del.disabledReason = "目录不可删除";
  else if (it.kind === "asset" && !assetActions?.delete) del.disabledReason = "没有删除该资产的权限";

  return [rename, resetTitle, duplicate, move, link, del];
}
