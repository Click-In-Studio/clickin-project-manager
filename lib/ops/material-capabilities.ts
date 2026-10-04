import { canAccessNodesBatch, type NodeKeyParts } from "../perm/grant-template";
import type { GrantActor } from "../perm/grant-check";
import type { Material } from "./material-db";
import {
  listMaterialLotCapabilityFacts,
  listMaterialSubjectRelations,
} from "./material-perm-db";
import {
  MATERIAL_PERMISSION_NODES,
  type MaterialCapabilities,
  type MaterialPermissionName,
} from "./material-permission-types";

const NAMES = Object.keys(MATERIAL_PERMISSION_NODES) as MaterialPermissionName[];

function nodesFor(resourceId: string): NodeKeyParts[] {
  return NAMES.map((name) => ({
    resourceType: "material", resourceId,
    resourceSub: MATERIAL_PERMISSION_NODES[name].sub,
    verb: MATERIAL_PERMISSION_NODES[name].verb,
  }));
}

function explicitMap(results: { allowed: boolean }[]): Record<MaterialPermissionName, boolean> {
  return Object.fromEntries(NAMES.map((name, index) => [name, results[index].allowed])) as
    Record<MaterialPermissionName, boolean>;
}

function capabilities(
  explicit: Record<MaterialPermissionName, boolean>,
  relation: { member: boolean; poc: boolean },
  archived: boolean,
): MaterialCapabilities {
  const enabled = (value: boolean) => !archived && value;
  return {
    createDefinition: enabled(explicit.definitionCreate || relation.poc),
    editDefinition: enabled(explicit.definitionEdit || relation.poc),
    deleteDefinition: enabled(explicit.definitionDelete || relation.poc),
    confirmReceipt: enabled(explicit.receipt || relation.member),
    checkoutSelf: enabled(true),
    checkoutForOthers: enabled(explicit.checkoutForOthers || relation.member),
    returnOwn: enabled(true),
    returnForOthers: enabled(explicit.returnForOthers || relation.member),
    reportDamageInCustody: enabled(true),
    manageMaintenance: enabled(explicit.maintenance || relation.member),
    manageSources: enabled(explicit.sources || relation.poc),
    adjustStock: enabled(explicit.adjustment),
    exitStock: enabled(explicit.exit),
    returnToSource: enabled(explicit.exit && (explicit.sources || relation.poc)),
    manageIdentifiers: enabled(explicit.identifiers),
  };
}

/** 服务端批量能力合同：全局键、可代表责任方、每物料与每批次动作同批返回。 */
export async function getMaterialCapabilities(
  actor: GrantActor, productionId: string, archived: boolean, materials: Material[],
) {
  const [relations, lots, access] = await Promise.all([
    listMaterialSubjectRelations(productionId, actor.userId),
    listMaterialLotCapabilityFacts(productionId, actor.userId),
    canAccessNodesBatch(actor, productionId, [
      ...nodesFor("*"), ...materials.flatMap((material) => nodesFor(material.id)),
    ]),
  ]);
  const global = capabilities(explicitMap(access.slice(0, NAMES.length)), { member: false, poc: false }, archived);
  const byMaterial = Object.fromEntries(materials.map((material, index) => {
    const relation = relations.find((r) =>
      (material.departmentId && r.kind === "dept" && r.id === material.departmentId)
      || (material.groupId && r.kind === "group" && r.id === material.groupId))
      ?? { member: false, poc: false };
    return [material.id, capabilities(
      explicitMap(access.slice((index + 1) * NAMES.length, (index + 2) * NAMES.length)),
      relation, archived,
    )];
  }));
  const byLot = Object.fromEntries(lots.map((lot) => {
    const material = byMaterial[lot.materialId];
    return [lot.id, {
      confirmReceipt: material.confirmReceipt && lot.expectedQuantity > 0,
      checkoutSelf: material.checkoutSelf && lot.inStockQuantity > 0,
      checkoutForOthers: material.checkoutForOthers && lot.inStockQuantity > 0,
      returnOwn: material.returnOwn && lot.hasOwnOutstandingCheckout,
      returnForOthers: material.returnForOthers && lot.checkedOutQuantity > 0,
      reportDamageInCustody: material.reportDamageInCustody && lot.hasOwnOutstandingCheckout,
      manageMaintenance: material.manageMaintenance
        && (lot.inStockQuantity > 0 || lot.checkedOutQuantity > 0 || lot.maintenanceQuantity > 0),
      adjustStock: material.adjustStock,
      exitStock: material.exitStock
        && (lot.inStockQuantity > 0 || lot.checkedOutQuantity > 0 || lot.maintenanceQuantity > 0),
      returnToSource: material.returnToSource && lot.inStockQuantity > 0,
    }];
  }));
  return { global, representableSubjects: relations, byMaterial, byLot };
}
