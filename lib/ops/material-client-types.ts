/** 物料台账客户端合同；保持零 node 依赖。 */
import type { MaterialCapabilities } from "./material-permission-types";
import type { MaterialIdentifier } from "./material-identifier-types";
import type { MaterialSourceType, MaterialStockBucket, MaterialTrackingStrategy } from "./material-types";

export type MaterialListItem = {
  id: string; productionId: string; number: string; name: string; category: string;
  trackingStrategy: MaterialTrackingStrategy; unit: string; quantityScale: number;
  departmentId: string | null; departmentName: string | null;
  groupId: string | null; groupName: string | null; location: string;
  expectedQuantity: number; heldQuantity: number; availableQuantity: number;
  inStockQuantity: number; checkedOutQuantity: number; maintenanceQuantity: number;
  exitedQuantity: number; cancelledQuantity: number; netConsumedQuantity: number;
  sourceSummary: string; abnormalQuantity: number;
  notes: string; createdBy: string; createdAt: string; updatedAt: string;
};

export type MaterialOverviewKey = "pendingReceipt" | "checkedOut" | "maintenance"
  | "overdueSourceReturn" | "sourceException";
export type MaterialOverviewItem = { count: number; materialIds: string[] };
export type MaterialOverview = Record<MaterialOverviewKey, MaterialOverviewItem>;

export type MaterialLotView = {
  id: string; materialId: string; confirmedQuantity: number; location: string;
  sourceType: MaterialSourceType; sourceLabel: string; sourceReference: string; sourceNote: string;
  expectedArrivalAt: string | null; returnDueAt: string | null; returnDueQuantity: number | null;
  arrivedQuantity: number; actualArrivalAt: string | null; returnedToSourceQuantity: number;
  openSourceExceptionQuantity: number; sourceStatus: string;
  expectedQuantity: number; inStockQuantity: number; checkedOutQuantity: number;
  maintenanceQuantity: number; exitedQuantity: number; cancelledQuantity: number;
  currentBucket: MaterialStockBucket | null; createdAt: string;
};

export type MaterialMovementView = {
  id: string; lotId: string; fromBucket: MaterialStockBucket; toBucket: MaterialStockBucket;
  quantity: number; returnOfMovementId: string | null; reason: string; exitReason: string | null;
  fromLocation: string; toLocation: string;
  custodian: { kind: "user" | "dept" | "group" | "event"; id: string } | null;
  custodianLabel: string; note: string; occurredAt: string; createdAt: string;
};

export type MaterialCheckoutView = {
  movementId: string; lotId: string; checkedOutQuantity: number; returnedQuantity: number;
  settledQuantity: number; outstandingQuantity: number; createdAt: string;
  custodian: { kind: "user" | "dept" | "group" | "event"; id: string } | null;
  custodianLabel: string;
};

export type MaterialCapabilitiesResponse = {
  global: MaterialCapabilities;
  representableSubjects: Array<{ kind: "dept" | "group"; id: string; name: string; member: boolean; poc: boolean }>;
  byMaterial: Record<string, MaterialCapabilities>;
  byLot: Record<string, Pick<MaterialCapabilities,
    "confirmReceipt" | "checkoutSelf" | "checkoutForOthers" | "returnOwn" |
    "returnForOthers" | "reportDamageInCustody" | "manageMaintenance" |
    "adjustStock" | "exitStock" | "returnToSource">>;
};

export type MaterialDetailResponse = {
  material: MaterialListItem;
  lots: MaterialLotView[];
  identifiers: MaterialIdentifier[];
  checkouts: MaterialCheckoutView[];
  lotDetails: Array<{ lotId: string; movements: MaterialMovementView[];
    sourceExceptions: Array<{ id: string; kind: string; quantity: number; note: string; isResolved: boolean }> }>;
  capabilities: MaterialCapabilitiesResponse;
};
