/**
 * 用户组的门。两型分道，因为它们的影响半径不同。
 *
 * ## A 型（event 绑定，`eventId` 非空）
 *
 * 门 = 该 event 的内容编辑权 `hasEventContentEdit`——和「给流程项安排人」同一把钥匙。
 * 理由：rundown 是 organizer 定好、大家遵守的东西，编组就是排 rundown 的一部分。
 *
 * 副作用要认：**organizer 可以任命任意组员当组 POC，而组 POC 会拿到该组所领 task
 * 的编辑与指派权**。这是「舞监助理带几个 runner 成立进场对光小组」这个场景的必要
 * 代价，范围限定在这一个 event 内，已定谳接受。它是判定端的新入口，进总表 §0.9。
 *
 * ## B 型（项目级，`eventId` 为空）
 *
 * 门 = `node:user_group/*` 那组键。**设 POC 单独一枚 `poc@edit`，不与 `@edit` 合并**——
 * B 型组的 POC 会在**所有**引用它的 event 里生效，把它并进 @edit 等于让拿到建组权
 * 的人同时拿到跨 event 的任命权。
 *
 * ## 「用」与「改」是两回事
 *
 * organizer 拿 `hasEventContentEdit` 可以把 B 型组挂到自己 event 的流程项上，但改不了
 * 它的成员和 POC——那要 `user_group` 键。这个不对称是白送的，不用额外设计。
 */

import { hasEffectiveGrant, type GrantActor } from "./grant-check";
import { hasEventContentEdit } from "./event-permissions";
import type { EventGroup } from "./event-group-db";

/** 建 A 型组要的东西：目标 event 及其状态（决定 details@edit 还是 publication@edit）。 */
export type EventGate = { eventId: string; status: string };

/**
 * 能不能建组。
 * A 型看目标 event 的内容编辑权；B 型看 `user_group/*@create`。
 */
export async function canCreateEventGroup(
  actor: GrantActor,
  productionId: string,
  event: EventGate | null,
): Promise<boolean> {
  if (event) return hasEventContentEdit(actor, productionId, event.eventId, event.status);
  return hasEffectiveGrant(actor, productionId, "user_group", "*", "*", "create");
}

/** 能不能改组的名称 / 地点 / 颜色 / 成员（不含 POC，见 {@link canSetEventGroupPoc}）。 */
export async function canEditEventGroup(
  actor: GrantActor,
  productionId: string,
  group: EventGroup,
  event: EventGate | null,
): Promise<boolean> {
  if (group.eventId !== null) {
    // A 型：只有它自己所属的那个 event 的内容编辑权才算数
    if (!event || event.eventId !== group.eventId) return false;
    return hasEventContentEdit(actor, productionId, event.eventId, event.status);
  }
  return hasEffectiveGrant(actor, productionId, "user_group", group.id, "*", "edit");
}

/**
 * 能不能设组的 POC。
 *
 * A 型与 @edit 同门（影响限该 event）；B 型要独立的 `poc@edit`——它的 POC 跨 event 生效。
 */
export async function canSetEventGroupPoc(
  actor: GrantActor,
  productionId: string,
  group: EventGroup,
  event: EventGate | null,
): Promise<boolean> {
  if (group.eventId !== null) return canEditEventGroup(actor, productionId, group, event);
  return hasEffectiveGrant(actor, productionId, "user_group", group.id, "poc", "edit");
}

/** 能不能删组。 */
export async function canDeleteEventGroup(
  actor: GrantActor,
  productionId: string,
  group: EventGroup,
  event: EventGate | null,
): Promise<boolean> {
  if (group.eventId !== null) return canEditEventGroup(actor, productionId, group, event);
  return hasEffectiveGrant(actor, productionId, "user_group", group.id, "*", "delete");
}

/**
 * 能不能把组挂到流程项上 / 从流程项上摘下。
 *
 * 恒等于该 event 的内容编辑权——**与组本身的两型无关**。这就是「用 ≠ 改」：
 * 拿到 B 型组的人不需要 user_group 键就能用它排自己的 rundown。
 *
 * 反向也成立：组 POC 不因为自己的组被排进某个 rundown 就获得改 rundown 的权力
 * （用户定谳：「如果一个用户组直接被绑到 schedule，这个 POC 应该是没有 schedule
 * assign 权的」）——本函数不查 isGroupPoc，就是这条的落实。
 */
export function canBindGroupToSchedule(
  actor: GrantActor,
  productionId: string,
  event: EventGate,
): Promise<boolean> {
  return hasEventContentEdit(actor, productionId, event.eventId, event.status);
}
