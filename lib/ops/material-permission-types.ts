/** #822：物料权限键与前端能力名的单一事实源（零 node 依赖，可进客户端包）。 */

export const MATERIAL_PERMISSION_NODES = {
  definitionCreate: { sub: "definition", verb: "create" },
  definitionEdit: { sub: "definition", verb: "edit" },
  definitionDelete: { sub: "definition", verb: "delete" },
  receipt: { sub: "receipts", verb: "edit" },
  checkoutForOthers: { sub: "circulation/checkouts", verb: "edit" },
  returnForOthers: { sub: "circulation/returns", verb: "edit" },
  maintenance: { sub: "maintenance", verb: "edit" },
  sources: { sub: "sources", verb: "edit" },
  adjustment: { sub: "stock/adjustments", verb: "edit" },
  exit: { sub: "stock/exits", verb: "edit" },
  identifiers: { sub: "identifiers", verb: "edit" },
} as const;

export type MaterialPermissionName = keyof typeof MATERIAL_PERMISSION_NODES;

export const MATERIAL_PERMISSION_KEYS = Object.fromEntries(
  Object.entries(MATERIAL_PERMISSION_NODES).map(([name, node]) => [
    name, `node:material/*/${node.sub}@${node.verb}`,
  ]),
) as Record<MaterialPermissionName, string>;

/** 普通物料统管：跨责任方代办日常事实；不含三个治理保留段。 */
export const MATERIAL_ADMIN_KEYS: readonly string[] = [
  MATERIAL_PERMISSION_KEYS.definitionCreate,
  MATERIAL_PERMISSION_KEYS.definitionEdit,
  MATERIAL_PERMISSION_KEYS.definitionDelete,
  MATERIAL_PERMISSION_KEYS.receipt,
  MATERIAL_PERMISSION_KEYS.checkoutForOthers,
  MATERIAL_PERMISSION_KEYS.returnForOthers,
  MATERIAL_PERMISSION_KEYS.maintenance,
  MATERIAL_PERMISSION_KEYS.sources,
];

/** 库存与标识治理：只能显式授予。 */
export const MATERIAL_GOVERNANCE_KEYS: readonly string[] = [
  MATERIAL_PERMISSION_KEYS.adjustment,
  MATERIAL_PERMISSION_KEYS.exit,
  MATERIAL_PERMISSION_KEYS.identifiers,
];

export type MaterialCapabilities = {
  createDefinition: boolean;
  editDefinition: boolean;
  deleteDefinition: boolean;
  confirmReceipt: boolean;
  checkoutSelf: boolean;
  checkoutForOthers: boolean;
  returnOwn: boolean;
  returnForOthers: boolean;
  reportDamageInCustody: boolean;
  manageMaintenance: boolean;
  manageSources: boolean;
  adjustStock: boolean;
  exitStock: boolean;
  returnToSource: boolean;
  manageIdentifiers: boolean;
};
