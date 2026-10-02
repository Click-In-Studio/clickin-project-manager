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

export function isMaterialTrackingStrategy(value: unknown): value is MaterialTrackingStrategy {
  return typeof value === "string"
    && (MATERIAL_TRACKING_STRATEGIES as readonly string[]).includes(value);
}

export function quantityFitsScale(quantity: number, scale: number): boolean {
  if (!Number.isFinite(quantity) || !Number.isInteger(scale) || scale < 0 || scale > 3)
    return false;
  const factor = 10 ** scale;
  return Math.abs(quantity * factor - Math.round(quantity * factor)) < 1e-8;
}
