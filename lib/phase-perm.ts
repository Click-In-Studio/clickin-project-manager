/**
 * phase 写门（create/edit/delete 三动作共享，防两处路由各写一份漂移）：
 *
 *   phase/*@<verb>（hasEffectiveGrant，owner 旁路内建）
 *   ∨ 部门 POC 管自己部门的 dept-level phase
 *     （policy.phase_dept_poc_create，形状 C 活引用判定——换 POC 自动跟随）
 *
 * deptId = 目标归属：创建时取 body（想建在哪个部门），改/删时取存量行。
 * null = production-level，只认 grant 路径。
 */
import { hasEffectiveGrant, type GrantActor } from "./grant-check";
import { isPolicyOn } from "./policy-db";

export async function canManagePhaseScope(
  actor: GrantActor,
  pocDeptIds: string[],
  productionId: string,
  deptId: string | null,
  verb: "create" | "edit" | "delete",
): Promise<boolean> {
  if (await hasEffectiveGrant(actor, productionId, "phase", "*", "*", verb)) return true;
  return deptId !== null
    && pocDeptIds.includes(deptId)
    && await isPolicyOn(productionId, "policy.phase_dept_poc_create");
}
