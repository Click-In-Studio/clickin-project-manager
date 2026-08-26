/**
 * 剧本正文的访问门。
 *
 * 抽出来是因为它被复制过：`/production/[id]/script` 与
 * `/production/[id]/script/print` 各写了一份同样的三段式判断。门被复制就会漂——
 * 有人收紧其中一处，另一处还开着，而这道门管的是剧本正文本身。
 *
 * 现在两处调同一个函数，"打印页的权限与剧本页一致"从**注释里的承诺**
 * 变成**结构上的事实**。
 */
import { hasGrant } from "./grant-check";

/** `getProductionPermissionContext()` 返回的 permCtx 里本门用到的部分。 */
type ScriptActor = {
  userId: string;
  isAdmin: boolean;
  isOwner: boolean;
};

/** 未通过时跳转的 unauthorized URL（两处文案与资源键必须一致，所以也放这儿）。 */
export function scriptBlocksUnauthorizedUrl(productionId: string): string {
  return `/unauthorized?resource=node%3Ascript%2F*%2Fblocks%40view&id=${productionId}`;
}

/**
 * 能否读剧本正文。
 *
 * 注意 isAdmin / isOwner 是**旁路**而不是权限行：系统管理员与演出所有者不经
 * grant 行判定。这与仓库现有写法一致（见 `app/production/[id]/script/page.tsx`
 * 迁移前的内联版本），本次抽取不改变判定语义，只消灭副本。
 */
export async function canViewScriptBlocks(
  actor: ScriptActor,
  productionId: string,
): Promise<boolean> {
  if (actor.isAdmin || actor.isOwner) return true;
  return hasGrant(actor.userId, productionId, "script", "*", "blocks", "view");
}
