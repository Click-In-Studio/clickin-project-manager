import { getPool } from "../pg";
import { broadcastWikiLibraryChange } from "../wiki/collab";
import { canViewWiki } from "../wiki/perm";
import { canViewAssetById } from "../asset/perm";
import type { GrantActor } from "../grant-check";
import {
  getNode, insertNode, moveNode, tailSortKey, placementSortKey,
  type NodeEntry, type NodePlacement, type NodeRecord,
} from "./db";
import { canEnumerateNode, localEnumerableNodeIds } from "./perm";

// ─── 软链接（kind='link'，接替 wiki_alias，#358 不变量全数延续）──────────────
//
// link 有自己的 id/parent_id/sort_key，内容指向另一个 node（link_target_id 真 FK
// CASCADE——目标删除链接随之消亡，原「手清 wiki_alias」两条 SQL 退役）。
//
// 【link 只链一个节点，不是链一棵子树】link 是**叶子**：不展开目标子项、不能在
// 它下面新建（validateParent 拒收 link 作父）。链式 link 结构上不存在（目标必须
// 非 link，建链时校验 + 环不可能经 link 形成）。
//
// 【不可让步】link 不是授权面。CHECK 钉死 listable=true ∧ is_public=false
// （原「表上无权限列」的物理保证换此形态），不接受 grant / 部门分享：
//   可枚举(u, link) ⟺ 可枚举(u, link 的父) ∧ **本地**可枚举(u, 目标)
//   读内容        ⟺ 目标自己的内容门（wiki→canViewWiki / asset→canViewAsset）
// 第二合取项不含目标祖先链——link 给目标的是第二个位置，位置维由 link 自己的
// 父链承担。目标被移走 link 不受影响（认 id 不认位置）。
//
// 目标 kind 本批收 wiki | asset（folder 目标=「链一棵子树」的另一形态，待议）。

const LINKABLE_TARGET_KINDS = new Set(["wiki", "asset"]);

export function isLinkableTarget(target: NodeRecord): boolean {
  return LINKABLE_TARGET_KINDS.has(target.kind);
}

/** 内容门转发：link 一票不投，永远重判目标。 */
export async function canReadLinkTarget(
  actor: GrantActor, productionId: string, target: NodeRecord,
): Promise<boolean> {
  if (target.kind === "wiki" && target.wikiId) return canViewWiki(actor, productionId, target.wikiId);
  if (target.kind === "asset" && target.assetId) {
    return canViewAssetById(actor, productionId, target.assetId, "meta");
  }
  return false;
}

/** 建链的目标可达门：枚举面全式 ∨ 内容面——两条发现路径任一即可达。 */
export async function canReachLinkTarget(
  actor: GrantActor, productionId: string, target: NodeRecord,
): Promise<boolean> {
  if (!isLinkableTarget(target)) return false;
  if (await canEnumerateNode(actor, productionId, target.id)) return true;
  return canReadLinkTarget(actor, productionId, target);
}

/** 目录树里该用户能看到的 link（判定式）：父可枚举（null=顶层恒真）∧ 目标本地
 *  可枚举。目标解析不到的行已被 listNodeLibrary 惰性兜底掉。 */
export async function filterEnumerableLinkEntries(
  actor: GrantActor,
  productionId: string,
  links: NodeEntry[],
  enumerable: { wildcard: boolean; ids: Set<string> },
): Promise<NodeEntry[]> {
  const placed = links.filter(l =>
    l.parentId === null || enumerable.wildcard || enumerable.ids.has(l.parentId));
  if (placed.length === 0) return [];
  const targetIds = [...new Set(placed.map(l => l.linkTargetId!).filter(Boolean))];
  const localOk = await localEnumerableNodeIds(actor, productionId, targetIds);
  return placed.filter(l => l.linkTargetId !== null && localOk.has(l.linkTargetId));
}

/** 单个 link 的可枚举判定（全式，路由/工具单点用）。 */
export async function canEnumerateLinkNode(
  actor: GrantActor,
  productionId: string,
  link: NodeRecord,
  enumerable: { wildcard: boolean; ids: Set<string> },
): Promise<boolean> {
  if (link.parentId !== null && !enumerable.wildcard && !enumerable.ids.has(link.parentId)) return false;
  if (!link.linkTargetId) return false;
  const local = await localEnumerableNodeIds(actor, productionId, [link.linkTargetId]);
  return local.has(link.linkTargetId);
}

/** link 不得建在目标自己的子树内（含目标本身）——不是防环（link 是叶子），是防
 *  无意义结构，同时给未来「透读目标子树」档位留门。 */
async function placeInsideTargetSubtree(
  productionId: string, parentId: string | null, targetId: string,
): Promise<boolean> {
  if (parentId === null) return false;
  if (parentId === targetId) return true;
  const { rows } = await getPool().query<{ hit: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, 1 AS depth FROM node WHERE id = $1 AND production_id = $3
       UNION ALL
       SELECT n.id, n.parent_id, c.depth + 1 FROM node n JOIN chain c ON n.id = c.parent_id
       WHERE c.depth < 100
     )
     SELECT EXISTS (SELECT 1 FROM chain WHERE id = $2) AS hit`,
    [parentId, targetId, productionId],
  );
  return rows[0].hit;
}

export type NodeLinkError =
  | "target_not_found" | "parent_not_found" | "unsupported_target" | "inside_target_subtree" | "duplicate";

/** 建 link。门（容器写门/落位门/目标可达）由调用方在此之前跑完。 */
export async function createNodeLink(params: {
  productionId: string;
  parentId: string | null;
  targetNodeId: string;
  createdBy: string;
  place?: NodePlacement;
  displayTitle?: string | null;
}): Promise<{ ok: true; link: NodeRecord } | { ok: false; reason: NodeLinkError }> {
  const { productionId, parentId, targetNodeId } = params;
  const target = await getNode(targetNodeId, productionId);
  if (!target) return { ok: false, reason: "target_not_found" };
  if (!isLinkableTarget(target)) return { ok: false, reason: "unsupported_target" };
  if (parentId !== null) {
    const p = await getNode(parentId, productionId);
    if (!p || (p.kind !== "folder" && p.kind !== "wiki")) return { ok: false, reason: "parent_not_found" };
  }
  if (await placeInsideTargetSubtree(productionId, parentId, targetNodeId)) {
    return { ok: false, reason: "inside_target_subtree" };
  }
  const sortKey = params.place
    ? await placementSortKey(productionId, parentId, params.place, null)
    : await tailSortKey(productionId, parentId);
  let id: string;
  try {
    id = await insertNode({
      productionId, kind: "link", parentId, sortKey,
      linkTargetId: targetNodeId, title: normalizeDisplayTitle(params.displayTitle),
      listable: true, isPublic: false, createdBy: params.createdBy,
    });
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code?: string }).code === "23505") {
      return { ok: false, reason: "duplicate" };
    }
    throw e;
  }
  broadcastWikiLibraryChange(productionId, { kind: "created", wikiId: id });
  return { ok: true, link: (await getNode(id, productionId))! };
}

/** 移动/重排 link（位置面）。比通用 moveNode 多一道目标子树校验。门由调用方跑。 */
export async function moveNodeLink(
  id: string, productionId: string,
  patch: { parentId?: string | null; place?: NodePlacement },
): Promise<{ ok: true; link: NodeRecord } | { ok: false; reason: NodeLinkError | "not_found" }> {
  const existing = await getNode(id, productionId);
  if (!existing || existing.kind !== "link") return { ok: false, reason: "not_found" };
  const nextParentId = patch.parentId !== undefined ? patch.parentId : existing.parentId;
  if (nextParentId !== null && nextParentId !== existing.parentId) {
    const p = await getNode(nextParentId, productionId);
    if (!p || (p.kind !== "folder" && p.kind !== "wiki")) return { ok: false, reason: "parent_not_found" };
  }
  if (existing.linkTargetId
      && await placeInsideTargetSubtree(productionId, nextParentId, existing.linkTargetId)) {
    return { ok: false, reason: "inside_target_subtree" };
  }
  try {
    const moved = await moveNode(id, productionId, patch);
    if (!moved) return { ok: false, reason: "not_found" };
    return { ok: true, link: moved };
  } catch (e) {
    if (e instanceof Error && e.message === "duplicate_link_in_container") {
      return { ok: false, reason: "duplicate" };
    }
    throw e;
  }
}

/** 空白显示名收敛成 null＝跟随目标——「改回自动」和「没设过」必须是同一状态。 */
function normalizeDisplayTitle(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
}

/** 改显示名：只动这个位置上的标签，目标一根汗毛不动。门与删除同档（容器写门 ∨
 *  创建者），不需要目标 edit 权。 */
export async function renameNodeLink(
  id: string, productionId: string, displayTitle: string | null,
): Promise<NodeRecord | null> {
  const { rowCount } = await getPool().query(
    `UPDATE node SET title = $3, updated_at = now()
     WHERE id = $1 AND production_id = $2 AND kind = 'link'`,
    [id, productionId, normalizeDisplayTitle(displayTitle)],
  );
  if (!rowCount) return null;
  broadcastWikiLibraryChange(productionId, { kind: "updated", wikiId: id });
  return getNode(id, productionId);
}

/** 指向某节点的所有 link（删除前「有几处软链接」提示 / 目标页位置列表）。 */
export async function listLinksForTarget(
  productionId: string, targetNodeId: string,
): Promise<NodeRecord[]> {
  const { rows } = await getPool().query(
    `SELECT id FROM node WHERE production_id = $1 AND link_target_id = $2 ORDER BY created_at`,
    [productionId, targetNodeId],
  );
  const out: NodeRecord[] = [];
  for (const r of rows) {
    const n = await getNode(r.id, productionId);
    if (n) out.push(n);
  }
  return out;
}
