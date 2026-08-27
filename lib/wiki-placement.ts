import { ensureDramaturgyRootAnchor, getDramaturgyTreeConfig } from "./wiki-db";
import { canPlaceWikiUnder, canWriteWikiContainer } from "./wiki-perm";
import type { WikiParentAnchor } from "./wiki-input";
import type { GrantActor } from "./grant-check";

// ─── 锚点落位的门 + 解析（#355；二轮 AI review #2）──────────────────────────
//
// 「挂到系统树根下」这条落位路径有个先有鸡还是先有蛋：根是**懒建**的，它的 id 要
// 等 ensureDramaturgyRootAnchor 跑完才知道；而 ensure 是写事务，不许跑在门前面
// （write-before-authz，#358 二轮的那条纪律）。
//
// 上一版的解法是"锚点路径不判落位双门，因为它们在锚点上恒真"，静态论证挂在**新建**
// 那一刻的属性上（is_public/listable 由 ensure 写死、isWikiAnchor 由 config 指向）。
// 问题是根建出来之后这些属性会变：有人在分享面把「戏剧构作」根的 listable 关掉，
// ① 就不再恒真，而这条路径照旧跳过它。
//
// 门（gateWikiAnchorPlacement，不写）与解析（resolveWikiAnchorParent，可能写）因此
// 拆成两个：门可以和别的落位门排在一起，解析永远排在所有门的后面。两种情形都不靠
// "默认值"：
//   根已存在 → id 当场就知道，照常跑双门，一道不省
//   根不存在 → 门过后才 ensure，而这一刻新建的根双门可证恒真（顶层 + listable
//              DEFAULT true ⇒ ①；config 指向它 ⇒ isWikiAnchor ⇒ ②）
//
// 竞态：两次读之间被别人抢先建出根，那次 ensure 会直接返回它而不重跑双门。要害是
// 那个根**也是这一刻新建的**，双门在它上面同样恒真——除非同一窗口里还有人把它的
// listable 关掉，量级上不予考虑。

export type AnchorGateFailure = "place" | "container";

/**
 * 门（**不写**）。可以和其他落位门排在一起，顺序随便挑——它一个字节都不落库。
 *
 * 根已存在：id 当场就知道，双门照跑，一道不省。
 * 根不存在：无门可跑，因为门要判的那个容器还不存在；它会在 resolve 那一刻被建出来，
 *   而新建的根双门可证恒真（顶层 + listable DEFAULT true ⇒ ①；config 指向它 ⇒
 *   isWikiAnchor ⇒ ②）。
 */
export async function gateWikiAnchorPlacement(
  actor: GrantActor,
  productionId: string,
  anchor: WikiParentAnchor,
): Promise<{ ok: true } | { ok: false; reason: AnchorGateFailure }> {
  if (anchor !== "dramaturgy") return { ok: true };
  // 只读口径——ensure 是写事务，判定前一律用它（wiki-db 头注释）
  const cfg = await getDramaturgyTreeConfig(productionId);
  if (!cfg.enabled || !cfg.rootWikiId) return { ok: true };
  if (!await canPlaceWikiUnder(actor, productionId, cfg.rootWikiId))
    return { ok: false, reason: "place" };
  if (!await canWriteWikiContainer(actor, productionId, cfg.rootWikiId))
    return { ok: false, reason: "container" };
  return { ok: true };
}

/**
 * 解析（**可能写**：根不存在时懒建）。只准在**所有**门之后调，一处都不许提前。
 *
 * 返回 null＝这棵树被配置关掉了，落到全库顶层——根容器上两道门恒真（见
 * canWriteWikiContainer 的 parentId=null 豁免）。
 *
 * 竞态：gate 与 resolve 之间被别人抢先建出根，这次 resolve 会直接返回它而没重跑双门。
 * 要害是那个根**也是刚建出来的**，双门在它上面同样恒真——除非同一窗口里还有人把它
 * 的 listable 关掉，量级上不予考虑。
 */
export async function resolveWikiAnchorParent(
  productionId: string,
  anchor: WikiParentAnchor,
): Promise<string | null> {
  if (anchor !== "dramaturgy") return null;
  return ensureDramaturgyRootAnchor(productionId);
}
