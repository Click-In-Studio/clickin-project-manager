/** 物料如何承载库存：业务分类（道具/服装/设备）与此正交。 */
export const MATERIAL_TRACKING_STRATEGIES = [
  "serialized", "bulk_returnable", "consumable",
] as const;
export type MaterialTrackingStrategy = typeof MATERIAL_TRACKING_STRATEGIES[number];

/** #310 表单可直接使用的常见单位建议；数据库允许项目实际需要的其他非空单位。 */
export const DEFAULT_MATERIAL_UNITS = [
  "件", "台", "个", "套", "组", "双", "把", "张", "片", "根", "条",
  "卷", "盒", "箱", "瓶", "桶", "米", "平方米", "升", "毫升", "公斤", "克",
] as const;

export const MATERIAL_STOCK_BUCKETS = [
  "expected", "in_stock", "checked_out", "maintenance", "exited",
] as const;
export type MaterialStockBucket = typeof MATERIAL_STOCK_BUCKETS[number];

/** 批次来源是当时事实的文字快照，不关联联系人或供应商主数据。 */
export const MATERIAL_SOURCE_TYPES = [
  "existing", "purchased", "produced", "rented", "borrowed",
] as const;
export type MaterialSourceType = typeof MATERIAL_SOURCE_TYPES[number];

export const MATERIAL_SOURCE_EXCEPTION_KINDS = [
  "lost", "damaged", "short",
] as const;
export type MaterialSourceExceptionKind = typeof MATERIAL_SOURCE_EXCEPTION_KINDS[number];

export const MATERIAL_SOURCE_STATUSES = [
  "not_arrived", "partially_arrived", "fully_arrived",
  "partially_returned", "fully_returned", "exception_open",
] as const;
export type MaterialSourceStatus = typeof MATERIAL_SOURCE_STATUSES[number];

export function isMaterialTrackingStrategy(value: unknown): value is MaterialTrackingStrategy {
  return typeof value === "string"
    && (MATERIAL_TRACKING_STRATEGIES as readonly string[]).includes(value);
}

export function isMaterialSourceType(value: unknown): value is MaterialSourceType {
  return typeof value === "string"
    && (MATERIAL_SOURCE_TYPES as readonly string[]).includes(value);
}

export function isMaterialSourceExceptionKind(
  value: unknown,
): value is MaterialSourceExceptionKind {
  return typeof value === "string"
    && (MATERIAL_SOURCE_EXCEPTION_KINDS as readonly string[]).includes(value);
}

export function deriveMaterialSourceStatus(facts: {
  confirmedQuantity: number;
  arrivedQuantity: number;
  returnDueQuantity: number | null;
  returnedQuantity: number;
  openExceptionQuantity: number;
}): MaterialSourceStatus {
  if (facts.openExceptionQuantity > 0) return "exception_open";
  if (facts.returnDueQuantity !== null && facts.returnedQuantity >= facts.returnDueQuantity)
    return "fully_returned";
  if (facts.returnedQuantity > 0) return "partially_returned";
  if (facts.arrivedQuantity <= 0) return "not_arrived";
  if (facts.arrivedQuantity < facts.confirmedQuantity) return "partially_arrived";
  return "fully_arrived";
}

export function quantityFitsScale(quantity: number, scale: number): boolean {
  if (!Number.isFinite(quantity) || !Number.isInteger(scale) || scale < 0 || scale > 3)
    return false;
  const factor = 10 ** scale;
  return Math.abs(quantity * factor - Math.round(quantity * factor)) < 1e-8;
}
