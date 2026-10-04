/** #822：物料事实写门的单一入口。关系授权不落 grant，治理动作只认显式键。 */

import { hasEffectiveGrant, type GrantActor } from "../perm/grant-check";
import { MATERIAL_PERMISSION_NODES, type MaterialPermissionName } from "./material-permission-types";
import { getMaterialSubjectRelation } from "./material-perm-db";
import { taskSubjectOf, type TaskSubject } from "./task-poc";

type MaterialRef = {
  id: string;
  departmentId: string | null;
  groupId: string | null;
};

async function hasMaterialPermission(
  actor: GrantActor,
  productionId: string,
  materialId: string,
  permission: MaterialPermissionName,
): Promise<boolean> {
  const node = MATERIAL_PERMISSION_NODES[permission];
  return hasEffectiveGrant(actor, productionId, "material", materialId, node.sub, node.verb);
}

async function canManageDaily(
  actor: GrantActor,
  productionId: string,
  material: MaterialRef,
  permission: "receipt" | "checkoutForOthers" | "returnForOthers" | "maintenance",
): Promise<boolean> {
  if (await hasMaterialPermission(actor, productionId, material.id, permission)) return true;
  return (await getMaterialSubjectRelation(
    productionId, actor.userId, taskSubjectOf(material),
  )).member;
}

/** 建定义：持定义 create，或是候选责任方 POC；无责任方不能走关系旁路。 */
export async function canCreateMaterial(
  actor: GrantActor, productionId: string, subject: TaskSubject | null,
): Promise<boolean> {
  if (await hasMaterialPermission(actor, productionId, "*", "definitionCreate")) return true;
  return subject
    ? (await getMaterialSubjectRelation(productionId, actor.userId, subject)).poc
    : false;
}

/** 改删定义：持具体定义键，或是物料当前责任方 POC。 */
export async function canManageMaterialDefinition(
  actor: GrantActor,
  productionId: string,
  material: MaterialRef,
  verb: "edit" | "delete",
): Promise<boolean> {
  const permission = verb === "edit" ? "definitionEdit" : "definitionDelete";
  if (await hasMaterialPermission(actor, productionId, material.id, permission)) return true;
  return (await getMaterialSubjectRelation(
    productionId, actor.userId, taskSubjectOf(material),
  )).poc;
}

/** 标识关系影响贴标和寻址，只认显式治理键（owner 旁路由 hasEffectiveGrant 提供）。 */
export function canManageMaterialIdentifiers(
  actor: GrantActor, productionId: string, materialId: string,
): Promise<boolean> {
  return hasMaterialPermission(actor, productionId, materialId, "identifiers");
}

export type MaterialMovementGate =
  | { operation: "receipt" | "cancel" | "repair" }
  | { operation: "checkout"; custodianUserId: string | null }
  | { operation: "return"; checkoutCustodianUserId: string | null }
  | { operation: "maintenance"; checkoutCustodianUserId: string | null }
  | { operation: "adjustment" }
  | { operation: "exit"; returnedToSource: boolean }
  | { operation: "reversal"; original: Exclude<MaterialMovementGate, { operation: "reversal" }> };

/**
 * 流转事实门：本人签出 / 本人返还 / 在自己保管期间报损不需代办键；
 * 责任方成员可记本责任方日常事实；调整、永久退出与标识治理不走关系旁路。
 */
export async function canRecordMaterialMovement(
  actor: GrantActor,
  productionId: string,
  material: MaterialRef,
  gate: MaterialMovementGate,
  allowSelf = true,
): Promise<boolean> {
  switch (gate.operation) {
    case "receipt":
    case "cancel":
      return canManageDaily(actor, productionId, material, "receipt");
    case "checkout":
      if (allowSelf && gate.custodianUserId === actor.userId) return true;
      return canManageDaily(actor, productionId, material, "checkoutForOthers");
    case "return":
      if (allowSelf && gate.checkoutCustodianUserId === actor.userId) return true;
      return canManageDaily(actor, productionId, material, "returnForOthers");
    case "maintenance":
      if (allowSelf && gate.checkoutCustodianUserId === actor.userId) return true;
      return canManageDaily(actor, productionId, material, "maintenance");
    case "repair":
      return canManageDaily(actor, productionId, material, "maintenance");
    case "adjustment":
      return hasMaterialPermission(actor, productionId, material.id, "adjustment");
    case "exit":
      if (!await hasMaterialPermission(actor, productionId, material.id, "exit")) return false;
      return !gate.returnedToSource
        || canManageMaterialSources(actor, productionId, material);
    case "reversal":
      return canRecordMaterialMovement(actor, productionId, material, gate.original, false);
  }
}

/** 来源与归还义务：显式来源键，或责任方 POC。 */
export async function canManageMaterialSources(
  actor: GrantActor, productionId: string, material: MaterialRef,
): Promise<boolean> {
  if (await hasMaterialPermission(actor, productionId, material.id, "sources")) return true;
  return (await getMaterialSubjectRelation(
    productionId, actor.userId, taskSubjectOf(material),
  )).poc;
}
