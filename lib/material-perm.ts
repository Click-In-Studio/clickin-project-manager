/**
 * 物料的写权限判定——**单一入口**。
 *
 * ## 为什么不是一句 hasEffectiveGrant
 *
 * 物料的实例门原本只认 `material/<id>@edit`，那是个域级钥匙：给了某个部门，
 * 他就能改别人部门的服装。而「有的道具组统管、有的各部门自管自的」
 * （lib/templates/shared.ts 里 MATERIAL_ADMIN 的注释）——两种剧组用同一把钥匙
 * 表达不了。结果是这把钥匙谁都不敢发，物料台账等于只有制作人能写。
 *
 * 所以补一条上下文判定：**责任方的 POC 可以管自己那一摊**。
 * production_material 的 (department_id, group_id) 与 task 是同一对字段，
 * 直接复用 lib/task-poc.ts 的 TaskSubject / isSubjectPoc——不新增概念。
 *
 * 于是两种剧组都表达得了：
 *   - 各部门自管：不发任何键，各 POC 天然管自己的
 *   - 道具组统管：单独给那个部门 MATERIAL_ADMIN
 *
 * ## 收敛
 *
 * 三个写点（POST / PATCH / DELETE）一律走这里，不再各写各的 hasEffectiveGrant。
 * tests/material-ledger.test.ts 有棘轮盯着——绕过去的写法会红。
 */

import { hasEffectiveGrant } from "./grant-check";
import { isSubjectPoc, taskSubjectOf, type TaskSubject } from "./task-poc";

type Actor = { userId: string; isAdmin: boolean; isOwner: boolean };

/** 建物料：持域级 create，或**是你要挂的那个责任方的 POC**。 */
export async function canCreateMaterial(
  actor: Actor, productionId: string, subject: TaskSubject | null,
): Promise<boolean> {
  if (await hasEffectiveGrant(actor, productionId, "material", "*", "*", "create")) return true;
  // 无责任方的物料属于台账公共部分，只有域级 create 能建——否则任何 POC 都能
  // 往公共区里塞东西，而谁都不负责
  return subject ? isSubjectPoc(productionId, subject, actor.userId) : false;
}

/**
 * 改 / 删既有物料：持该实例的 edit/delete，或是**它当前责任方**的 POC。
 *
 * 用当前责任方而非改后的：换责任方等于把东西交出去，交出去这个动作得由现在的
 * 持有方发起。至于接收方是否愿意接——那是流程问题，不是权限问题。
 */
export async function canWriteMaterial(
  actor: Actor,
  productionId: string,
  material: { id: string; departmentId: string | null; groupId: string | null },
  verb: "edit" | "delete",
): Promise<boolean> {
  if (await hasEffectiveGrant(actor, productionId, "material", material.id, "*", verb)) return true;
  const subject = taskSubjectOf(material);
  return subject ? isSubjectPoc(productionId, subject, actor.userId) : false;
}
