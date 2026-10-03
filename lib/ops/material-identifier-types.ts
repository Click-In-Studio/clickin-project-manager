export const MATERIAL_EXTERNAL_IDENTIFIER_TYPES = [
  "manufacturer_serial", "source_asset", "existing_barcode", "other",
] as const;

export type MaterialExternalIdentifierType =
  typeof MATERIAL_EXTERNAL_IDENTIFIER_TYPES[number];

export type MaterialIdentifierKind = "material_number" | "internal_code" | "external";

export type MaterialIdentifier = {
  id: string;
  productionId: string;
  materialId: string;
  lotId: string | null;
  kind: MaterialIdentifierKind;
  externalType: MaterialExternalIdentifierType | null;
  externalLabel: string;
  displayValue: string;
  isActive: boolean;
  retiredAt: string | null;
  retiredReason: string;
  createdAt: string;
};

/** GS1 风格 Mod-10：只校验人读号码，条码符号自己的校验仍由编码库负责。 */
export function materialIdentifierCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error("identifier digits required");
  let sum = 0;
  for (let i = digits.length - 1, offset = 0; i >= 0; i -= 1, offset += 1)
    sum += Number(digits[i]) * (offset % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

function padded(value: number, minimum: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("positive serial required");
  return String(value).padStart(minimum, "0");
}

export function formatMaterialNumber(serial: number): string {
  const digits = String(serial);
  return `M-${padded(serial, 4)}-${materialIdentifierCheckDigit(digits)}`;
}

export function formatMaterialStockCode(
  materialSerial: number,
  stockSerial: number,
  kind: "serialized" | "batch",
): string {
  const letter = kind === "serialized" ? "S" : "B";
  const digits = `${materialSerial}${stockSerial}`;
  return `M-${padded(materialSerial, 4)}-${letter}${padded(stockSerial, 3)}-${materialIdentifierCheckDigit(digits)}`;
}

/**
 * 所有码使用同一个查找规范，才能保证无类型扫描不会同时命中内部码和外部码。
 * 展示值仍原样保存；查找时允许省略空格和连字符、忽略大小写。
 */
export function normalizeGeneratedMaterialCode(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase().replace(/[\s-]+/g, "");
}

export function normalizeExternalMaterialCode(value: string): string {
  return normalizeGeneratedMaterialCode(value);
}

export function isValidExternalMaterialCode(value: string): boolean {
  const display = value.normalize("NFKC").trim();
  const normalized = normalizeExternalMaterialCode(value);
  return display.length >= 1 && display.length <= 128
    && normalized.length >= 1 && normalized.length <= 128
    && !/[\p{Cc}\p{Cf}]/u.test(display);
}

export function isMaterialExternalIdentifierType(
  value: unknown,
): value is MaterialExternalIdentifierType {
  return typeof value === "string"
    && (MATERIAL_EXTERNAL_IDENTIFIER_TYPES as readonly string[]).includes(value);
}
