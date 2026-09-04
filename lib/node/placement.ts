import { ensureDramaturgyRootAnchor, getDramaturgyTreeConfig } from "./anchors";
import { canPlaceNodeUnder, canWriteNodeContainer } from "./perm";
import type { GrantActor } from "../grant-check";

// ─── 锚点落位的门 + 解析（write-before-authz，逐字继承 wiki 侧 #355 拍板）─────
//
// 「挂到系统树根下」的先有鸡还是先有蛋：根是**懒建**的，id 要等 ensure 跑完才
// 知道；而 ensure 是写事务，不许跑在门前面。门（gate，不写）与解析（resolve，
// 可能写）因此拆成两个：门可以和别的落位门排在一起，解析永远排在所有门之后。
//   根已存在 → id 当场知道，双门照跑一道不省
//   根不存在 → 门过后才 ensure，新建的根双门可证恒真（顶层 ⇒ ①；config 指向
//              它 ⇒ isNodeAnchor ⇒ ②）
// 竞态论证同旧文件：gate 与 resolve 之间被抢先建根，那个根也是刚建的，双门在
// 它上面同样恒真。

export type NodeParentAnchor = "dramaturgy";

export type AnchorGateFailure = "place" | "container";

/** 门（**不写**）。只读配置口径——ensure 是写事务，判定前一律用只读口。 */
export async function gateNodeAnchorPlacement(
  actor: GrantActor,
  productionId: string,
  anchor: NodeParentAnchor,
): Promise<{ ok: true } | { ok: false; reason: AnchorGateFailure }> {
  if (anchor !== "dramaturgy") return { ok: true };
  const cfg = await getDramaturgyTreeConfig(productionId);
  if (!cfg.enabled || !cfg.rootNodeId) return { ok: true };
  if (!await canPlaceNodeUnder(actor, productionId, cfg.rootNodeId))
    return { ok: false, reason: "place" };
  if (!await canWriteNodeContainer(actor, productionId, cfg.rootNodeId))
    return { ok: false, reason: "container" };
  return { ok: true };
}

/** 解析（**可能写**：根不存在时懒建）。只准在**所有**门之后调。
 *  返回 null＝这棵树被配置关掉，落到全库顶层（根容器双门恒真）。 */
export async function resolveNodeAnchorParent(
  productionId: string,
  anchor: NodeParentAnchor,
): Promise<string | null> {
  if (anchor !== "dramaturgy") return null;
  return ensureDramaturgyRootAnchor(productionId);
}
