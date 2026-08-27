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
// 这里把两种情形分开，两边都不靠"默认值"：
//   根已存在 → id 当场就知道，照常跑双门，一道不省
//   根不存在 → 门过后才 ensure，而这一刻新建的根双门可证恒真（顶层 + listable
//              DEFAULT true ⇒ ①；config 指向它 ⇒ isWikiAnchor ⇒ ②）
//
// 竞态：两次读之间被别人抢先建出根，那次 ensure 会直接返回它而不重跑双门。要害是
// 那个根**也是这一刻新建的**，双门在它上面同样恒真——除非同一窗口里还有人把它的
// listable 关掉，量级上不予考虑。

export type AnchorGateFailure = "place" | "container";

/**
 * 解析 parentAnchor 声明的落位，并在解析前把落位双门跑完。
 *
 * 返回的 parentId 可能是 null：配置关掉了这棵树（ensure 返回 null）＝落到全库顶层，
 * 而根容器上两道门恒真（见 canWriteWikiContainer 的 parentId=null 豁免）。
 */
export async function gateAndResolveWikiAnchor(
  actor: GrantActor,
  productionId: string,
  anchor: WikiParentAnchor,
): Promise<{ ok: true; parentId: string | null } | { ok: false; reason: AnchorGateFailure }> {
  if (anchor !== "dramaturgy") return { ok: true, parentId: null };

  // 只读口径——渲染路径与门前判定都只准用它，ensure 留到门后（wiki-db 头注释）
  const cfg = await getDramaturgyTreeConfig(productionId);
  if (cfg.enabled && cfg.rootWikiId) {
    if (!await canPlaceWikiUnder(actor, productionId, cfg.rootWikiId))
      return { ok: false, reason: "place" };
    if (!await canWriteWikiContainer(actor, productionId, cfg.rootWikiId))
      return { ok: false, reason: "container" };
    return { ok: true, parentId: cfg.rootWikiId };
  }
  return { ok: true, parentId: await ensureDramaturgyRootAnchor(productionId) };
}
