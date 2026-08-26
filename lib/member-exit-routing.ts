/**
 * 成员退出的路由与门（#141）。
 *
 * 这两件事必须分开，混在一起就会出错：
 *
 *   路由 —— 谁被通知、谁被催。走直属上级链 → 制作人 → owner。上级最知情：
 *     owner 不知道某个灯光助理是不是真的走了，知道的是灯光设计。
 *
 *   门 —— 谁真的能推出口（复职 / 确认离组）。判据是 member 授权门，不是
 *     supervisor_id。supervisor_id 是一个**不携带任何权限的纯数据字段**，
 *     谁都能被设成谁的上级；让它单独决定「能不能把访问权还回去」，就等于开了
 *     一条改一个字段就获得人事处置权的路。而复职就是一次授权动作。
 *
 * 上级不持门时不阻断，只是终局不了——他可以表态（object / endorse，见
 * lib/member-status.ts），链继续往上，owner 必然兜底。这与
 * lib/approval-routing.ts 的阶梯定式同源：「上级持有该权限才能终局，否则只能
 * 转发」。
 */

import { getPool } from "./pg";
import { walkSupervisorChain, findProducers } from "./approval-routing";
import { hasEffectiveGrant } from "./grant-check";

/**
 * 处置成员退出所需的门：resource_type=member、id 与 sub 皆为通配、动词 delete。
 * 与 members 路由的 canRemoveMember 同源——「能把人移出剧组」就是这一枚。
 */
export async function canHandleMemberExit(
  ctx: { userId: string; isAdmin: boolean; isOwner: boolean },
  productionId: string,
): Promise<boolean> {
  return hasEffectiveGrant(ctx, productionId, "member", "*", "*", "delete");
}

export type ExitHandlerStage = "supervisor" | "producer" | "owner";

export type ExitHandler = {
  userId: string;
  stage: ExitHandlerStage;
  /** 上级链上的层数（0 = 直属上级）；制作人/owner 恒 0 */
  depth: number;
  /** 持 member 门 —— 能真的推出口，而不只是表态 */
  canFinalize: boolean;
};

async function getOwnerId(productionId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ owner_id: string | null }>(
    "SELECT owner_id::text AS owner_id FROM production WHERE id = $1",
    [productionId],
  );
  return rows[0]?.owner_id ?? null;
}

/**
 * 算出这次退出该通知谁，以及各自能不能终局。
 *
 * 顺序即阶梯顺序，去重按首次出现（一个人既是上级又是制作人，只出现在更近的那级）。
 * 退出者本人永远不在列表里——他不能审自己的退出，也不该收自己的待处理。
 */
export async function resolveExitHandlers(
  productionId: string,
  subjectUserId: string,
): Promise<ExitHandler[]> {
  const ownerId = await getOwnerId(productionId);

  const [chain, producers] = await Promise.all([
    walkSupervisorChain(productionId, subjectUserId),
    findProducers(productionId),
  ]);

  const ordered: Omit<ExitHandler, "canFinalize">[] = [
    ...chain.map((c) => ({ userId: c.userId, stage: "supervisor" as const, depth: c.depth })),
    ...producers.map((p) => ({ userId: p, stage: "producer" as const, depth: 0 })),
    ...(ownerId ? [{ userId: ownerId, stage: "owner" as const, depth: 0 }] : []),
  ];

  const seen = new Set<string>([subjectUserId]);
  const deduped = ordered.filter((h) => !seen.has(h.userId) && seen.add(h.userId));

  return Promise.all(
    deduped.map(async (h) => ({
      ...h,
      canFinalize: await canHandleMemberExit(
        { userId: h.userId, isAdmin: false, isOwner: h.userId === ownerId },
        productionId,
      ),
    })),
  );
}
