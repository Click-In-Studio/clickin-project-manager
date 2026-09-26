import { listNodeLibrary, type NodeEntry } from "./db";
import { listEnumerableNodeIds } from "./perm";
import { filterEnumerableLinkEntries } from "./link";
import { listEditableWikiIds } from "../wiki/perm";
import {
  listDramaturgySubtree, listDramaturgyLinks, listDramaturgyMoveInCandidates,
  type NodeMoveInCandidate,
} from "./dramaturgy";
import { getDramaturgyTreeConfig } from "./anchors";
import { listEffectiveGrantedResourceIds, type GrantActor } from "../perm/grant-check";
import type { AssetTreeActions } from "./tree-menu";

// ─── 目录树的唯一取数口（#357 枚举面 + #358 link，node 化后单数组四 kind）─────
//
// 树的节点集 = 可枚举的非 link 节点 ∪ 可枚举的 link。页面/路由一律走这一个
// 函数——两个消费方各自拼一遍就会各自决定 link 怎么过门（#357 症状① 成因）。

export type NodeTree = { nodes: NodeEntry[]; assetActions: AssetTreeActions };

/** 菜单与资产 PATCH / DELETE 逐键同源；两个集合查询，避免逐节点查库。 */
async function assetActionsFor(actor: GrantActor, productionId: string, nodes: NodeEntry[]): Promise<AssetTreeActions> {
  const assets = nodes.filter(n => n.kind === "asset" && n.assetId);
  if (assets.length === 0) return {};
  const [edit, del] = await Promise.all([
    listEffectiveGrantedResourceIds(actor, productionId, "asset", "meta", "edit"),
    // DELETE /assets/[assetId] 同样只认 *@delete；meta@delete 不代表删除整个资产。
    listEffectiveGrantedResourceIds(actor, productionId, "asset", "*", "delete"),
  ]);
  const editable = new Set(edit.ids);
  const deletable = new Set(del.ids);
  return Object.fromEntries(assets.map(n => [n.assetId!, {
    rename: edit.wildcard || editable.has(n.assetId!),
    delete: del.wildcard || deletable.has(n.assetId!),
  }]));
}

export async function listNodeTreeFor(actor: GrantActor, productionId: string): Promise<NodeTree> {
  const [all, enumerable] = await Promise.all([
    listNodeLibrary(productionId),
    listEnumerableNodeIds(actor, productionId),
  ]);
  const plain = all.filter(n => n.kind !== "link");
  const links = all.filter(n => n.kind === "link");
  const visiblePlain = enumerable.wildcard ? plain : plain.filter(n => enumerable.ids.has(n.id));
  const visibleLinks = await filterEnumerableLinkEntries(actor, productionId, links, enumerable);
  const nodes = [...visiblePlain, ...visibleLinks].sort((x, y) =>
    (x.sortKey ?? "￿").localeCompare(y.sortKey ?? "￿") || x.createdAt.localeCompare(y.createdAt));
  return { nodes, assetActions: await assetActionsFor(actor, productionId, nodes) };
}

/**
 * 作用域化工作区（「构作 · 灵感文档」）取数口。
 * subtree 在**全量**上算（未过枚举面）——越界判定与侧栏必须同源（#352）。
 */
export async function listDramaturgyTreeFor(
  actor: GrantActor, productionId: string, rootId: string | null,
): Promise<NodeTree & { subtree: NodeEntry[]; moveIn: NodeMoveInCandidate[] }> {
  const [all, enumerable, editable] = await Promise.all([
    listNodeLibrary(productionId),
    listEnumerableNodeIds(actor, productionId),
    listEditableWikiIds(actor, productionId),
  ]);
  const subtree = listDramaturgySubtree(all, rootId);
  const links = listDramaturgyLinks(all.filter(n => n.kind === "link"), subtree, rootId);
  const visibleLinks = await filterEnumerableLinkEntries(actor, productionId, links, enumerable);
  const visibleSubtree = (enumerable.wildcard
    ? subtree
    : subtree.filter(n => enumerable.ids.has(n.id))).filter(n => n.kind !== "link");
  const nodes = [...visibleSubtree, ...visibleLinks].sort((x, y) =>
    (x.sortKey ?? "￿").localeCompare(y.sortKey ?? "￿") || x.createdAt.localeCompare(y.createdAt));
  return {
    subtree,
    nodes,
    assetActions: await assetActionsFor(actor, productionId, nodes),
    moveIn: listDramaturgyMoveInCandidates(all, subtree, rootId, { enumerable, editable }, visibleLinks),
  };
}

export { getDramaturgyTreeConfig };
