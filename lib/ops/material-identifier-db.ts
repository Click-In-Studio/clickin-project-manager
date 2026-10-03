import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "../pg";
import {
  formatMaterialNumber,
  formatMaterialStockCode,
  isValidExternalMaterialCode,
  normalizeExternalMaterialCode,
  normalizeGeneratedMaterialCode,
  type MaterialExternalIdentifierType,
  type MaterialIdentifier,
  type MaterialIdentifierKind,
} from "./material-identifier-types";
import type { MaterialStockBucket, MaterialTrackingStrategy } from "./material-types";

const newIdentifierId = () => `mi_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
const newToken = () => randomBytes(24).toString("base64url");

type IdentifierRow = {
  id: string;
  production_id: string;
  material_id: string;
  lot_id: string | null;
  kind: MaterialIdentifierKind;
  external_type: MaterialExternalIdentifierType | null;
  external_label: string;
  display_value: string;
  is_active: boolean;
  retired_at: Date | null;
  retired_reason: string;
  created_at: Date;
};

function rowToIdentifier(row: IdentifierRow): MaterialIdentifier {
  return {
    id: row.id,
    productionId: row.production_id,
    materialId: row.material_id,
    lotId: row.lot_id,
    kind: row.kind,
    externalType: row.external_type,
    externalLabel: row.external_label,
    displayValue: row.display_value,
    isActive: row.is_active,
    retiredAt: row.retired_at?.toISOString() ?? null,
    retiredReason: row.retired_reason,
    createdAt: row.created_at.toISOString(),
  };
}

async function nextCounter(
  client: PoolClient,
  table: "production_material_number_counter" | "production_material_stock_code_counter",
  params: { productionId: string; materialId?: string; codeKind?: "serialized" | "batch" },
): Promise<number> {
  const query = table === "production_material_number_counter"
    ? `INSERT INTO production_material_number_counter(production_id, last_value)
       VALUES ($1, 1)
       ON CONFLICT (production_id) DO UPDATE
         SET last_value = production_material_number_counter.last_value + 1
       RETURNING last_value`
    : `INSERT INTO production_material_stock_code_counter
         (production_id, material_id, code_kind, last_value)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (production_id, material_id, code_kind) DO UPDATE
         SET last_value = production_material_stock_code_counter.last_value + 1
       RETURNING last_value`;
  const values = table === "production_material_number_counter"
    ? [params.productionId]
    : [params.productionId, params.materialId, params.codeKind];
  const { rows } = await client.query<{ last_value: string }>(query, values);
  return Number(rows[0].last_value);
}

export async function createMaterialNumberInTx(
  client: PoolClient,
  params: { productionId: string; materialId: string; createdBy: string },
): Promise<MaterialIdentifier> {
  const serial = await nextCounter(client, "production_material_number_counter", params);
  const display = formatMaterialNumber(serial);
  const { rows } = await client.query<IdentifierRow>(
    `INSERT INTO production_material_identifier
       (id, production_id, material_id, kind, display_value, normalized_value,
        serial_number, created_by)
     VALUES ($1,$2,$3,'material_number',$4,$5,$6,$7)
     RETURNING id, production_id, material_id, lot_id, kind, external_type,
               external_label, display_value, is_active, retired_at,
               retired_reason, created_at`,
    [newIdentifierId(), params.productionId, params.materialId, display,
      normalizeGeneratedMaterialCode(display), serial, params.createdBy],
  );
  return rowToIdentifier(rows[0]);
}

export async function createMaterialStockCodeInTx(
  client: PoolClient,
  params: {
    productionId: string;
    materialId: string;
    lotId: string;
    trackingStrategy: MaterialTrackingStrategy;
    createdBy: string;
  },
): Promise<MaterialIdentifier> {
  const kind = params.trackingStrategy === "serialized" ? "serialized" : "batch";
  const materialNumber = await client.query<{ serial_number: string }>(
    `SELECT serial_number::text FROM production_material_identifier
      WHERE production_id=$1 AND material_id=$2 AND kind='material_number'`,
    [params.productionId, params.materialId],
  );
  if (!materialNumber.rows[0]) throw new Error("material number missing");
  const serial = await nextCounter(client, "production_material_stock_code_counter", {
    ...params, codeKind: kind,
  });
  const display = formatMaterialStockCode(
    Number(materialNumber.rows[0].serial_number), serial, kind,
  );
  const { rows } = await client.query<IdentifierRow>(
    `INSERT INTO production_material_identifier
       (id, production_id, material_id, lot_id, kind, display_value,
        normalized_value, serial_number, token, created_by)
     VALUES ($1,$2,$3,$4,'internal_code',$5,$6,$7,$8,$9)
     RETURNING id, production_id, material_id, lot_id, kind, external_type,
               external_label, display_value, is_active, retired_at,
               retired_reason, created_at`,
    [newIdentifierId(), params.productionId, params.materialId, params.lotId,
      display, normalizeGeneratedMaterialCode(display), serial, newToken(), params.createdBy],
  );
  return rowToIdentifier(rows[0]);
}

export async function listMaterialIdentifiers(
  productionId: string,
  materialId: string,
  lotId?: string,
): Promise<MaterialIdentifier[]> {
  const { rows } = await getPool().query<IdentifierRow>(
    `SELECT id, production_id, material_id, lot_id, kind, external_type,
            external_label, display_value, is_active, retired_at,
            retired_reason, created_at
       FROM production_material_identifier
      WHERE production_id=$1 AND material_id=$2
        AND ($3::text IS NULL OR lot_id=$3)
      ORDER BY CASE kind WHEN 'material_number' THEN 0 WHEN 'internal_code' THEN 1 ELSE 2 END,
               created_at, id`,
    [productionId, materialId, lotId ?? null],
  );
  return rows.map(rowToIdentifier);
}

export async function getMaterialIdentifier(
  productionId: string,
  identifierId: string,
): Promise<MaterialIdentifier | null> {
  const { rows } = await getPool().query<IdentifierRow>(
    `SELECT id, production_id, material_id, lot_id, kind, external_type,
            external_label, display_value, is_active, retired_at,
            retired_reason, created_at
       FROM production_material_identifier
      WHERE production_id=$1 AND id=$2`,
    [productionId, identifierId],
  );
  return rows[0] ? rowToIdentifier(rows[0]) : null;
}

export class MaterialIdentifierError extends Error {
  constructor(
    readonly reason: "bad_code" | "duplicate_code" | "not_found" | "inactive" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export async function createExternalMaterialIdentifier(params: {
  productionId: string;
  materialId: string;
  lotId: string;
  externalType: MaterialExternalIdentifierType;
  externalLabel?: string;
  value: string;
  createdBy: string;
}): Promise<MaterialIdentifier> {
  const display = params.value.normalize("NFKC").trim();
  const label = (params.externalLabel ?? "").trim();
  if (!isValidExternalMaterialCode(params.value))
    throw new MaterialIdentifierError("bad_code", "外部标识须为 1–128 个可见字符");
  if ((params.externalType === "other") !== Boolean(label)
      || label.length > 32 || /[\p{Cc}\p{Cf}]/u.test(label))
    throw new MaterialIdentifierError("bad_code", "其他类型必须填写类型名称，标准类型不能另填名称");
  try {
    const { rows } = await getPool().query<IdentifierRow>(
      `INSERT INTO production_material_identifier
         (id, production_id, material_id, lot_id, kind, external_type,
          external_label, display_value, normalized_value, created_by)
       VALUES ($1,$2,$3,$4,'external',$5,$6,$7,$8,$9)
       RETURNING id, production_id, material_id, lot_id, kind, external_type,
                 external_label, display_value, is_active, retired_at,
                 retired_reason, created_at`,
      [newIdentifierId(), params.productionId, params.materialId, params.lotId,
        params.externalType, label, display, normalizeExternalMaterialCode(display), params.createdBy],
    );
    return rowToIdentifier(rows[0]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error
        && String(error.code) === "23505" && "table" in error
        && String(error.table) === "production_material_identifier")
      throw new MaterialIdentifierError("duplicate_code", "该标识已被本项目中的其他记录占用");
    throw error;
  }
}

export async function retireMaterialIdentifier(params: {
  productionId: string;
  identifierId: string;
  retiredBy: string;
  reason: string;
}): Promise<MaterialIdentifier> {
  if (!params.reason.trim())
    throw new MaterialIdentifierError("bad_code", "失效标识必须填写原因");
  const { rows } = await getPool().query<IdentifierRow>(
    `UPDATE production_material_identifier
        SET is_active=false, retired_at=now(), retired_by=$3, retired_reason=$4
      WHERE id=$1 AND production_id=$2 AND is_active
        AND kind <> 'material_number'
      RETURNING id, production_id, material_id, lot_id, kind, external_type,
                external_label, display_value, is_active, retired_at,
                retired_reason, created_at`,
    [params.identifierId, params.productionId, params.retiredBy, params.reason.trim()],
  );
  if (!rows[0]) {
    const existing = await getPool().query<{ kind: MaterialIdentifierKind; is_active: boolean }>(
      `SELECT kind, is_active FROM production_material_identifier
        WHERE id=$1 AND production_id=$2`,
      [params.identifierId, params.productionId],
    );
    if (!existing.rows[0]) throw new MaterialIdentifierError("not_found", "标识不存在");
    if (existing.rows[0].kind === "material_number")
      throw new MaterialIdentifierError("bad_code", "物料编号不可失效");
    throw new MaterialIdentifierError("inactive", "标识已经失效");
  }
  return rowToIdentifier(rows[0]);
}

export async function replaceMaterialStockIdentifier(params: {
  productionId: string;
  identifierId: string;
  replacedBy: string;
  reason: string;
}): Promise<{ retired: MaterialIdentifier; replacement: MaterialIdentifier }> {
  if (!params.reason.trim())
    throw new MaterialIdentifierError("bad_code", "换码必须填写原因");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<IdentifierRow & {
      tracking_strategy: MaterialTrackingStrategy;
    }>(
      `SELECT identifier.id, identifier.production_id, identifier.material_id,
              identifier.lot_id, identifier.kind, identifier.external_type,
              identifier.external_label, identifier.display_value,
              identifier.is_active, identifier.retired_at,
              identifier.retired_reason, identifier.created_at,
              material.tracking_strategy
         FROM production_material_identifier identifier
         JOIN production_material material
           ON material.id=identifier.material_id
          AND material.production_id=identifier.production_id
        WHERE identifier.production_id=$1 AND identifier.id=$2
        FOR UPDATE OF identifier`,
      [params.productionId, params.identifierId],
    );
    const row = current.rows[0];
    if (!row) throw new MaterialIdentifierError("not_found", "标识不存在");
    if (row.kind !== "internal_code" || !row.lot_id)
      throw new MaterialIdentifierError("bad_code", "只有内部码可以换码");
    if (!row.is_active)
      throw new MaterialIdentifierError("inactive", "内部码已经失效");
    const retired = await client.query<IdentifierRow>(
      `UPDATE production_material_identifier
          SET is_active=false, retired_at=now(), retired_by=$3, retired_reason=$4
        WHERE production_id=$1 AND id=$2
        RETURNING id, production_id, material_id, lot_id, kind, external_type,
                  external_label, display_value, is_active, retired_at,
                  retired_reason, created_at`,
      [params.productionId, params.identifierId, params.replacedBy, params.reason.trim()],
    );
    const replacement = await createMaterialStockCodeInTx(client, {
      productionId: params.productionId,
      materialId: row.material_id,
      lotId: row.lot_id,
      trackingStrategy: row.tracking_strategy,
      createdBy: params.replacedBy,
    });
    await client.query("COMMIT");
    return { retired: rowToIdentifier(retired.rows[0]), replacement };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type MaterialIdentifierResolution = {
  status: "valid" | "inactive" | "unavailable";
  identifier: MaterialIdentifier;
  materialNumber: string;
  internalCode: string | null;
  materialName: string;
  trackingStrategy: MaterialTrackingStrategy;
  currentBucket: MaterialStockBucket | null;
};

type ResolutionRow = IdentifierRow & {
  token: string | null;
  material_name: string;
  tracking_strategy: MaterialTrackingStrategy;
  material_number: string;
  internal_code: string | null;
  expected_quantity: string;
  in_stock_quantity: string;
  checked_out_quantity: string;
  maintenance_quantity: string;
};

function resolutionFromRow(row: ResolutionRow): MaterialIdentifierResolution {
  const buckets: Array<[MaterialStockBucket, number]> = [
    ["expected", Number(row.expected_quantity)],
    ["in_stock", Number(row.in_stock_quantity)],
    ["checked_out", Number(row.checked_out_quantity)],
    ["maintenance", Number(row.maintenance_quantity)],
  ];
  const occupied = buckets.filter(([, quantity]) => quantity > 0);
  return {
    status: !row.is_active
      ? "inactive"
      : row.lot_id === null || occupied.length > 0 ? "valid" : "unavailable",
    identifier: rowToIdentifier(row),
    materialNumber: row.material_number,
    internalCode: row.internal_code,
    materialName: row.material_name,
    trackingStrategy: row.tracking_strategy,
    currentBucket: occupied.length === 1 ? occupied[0][0] : null,
  };
}

const RESOLUTION_SELECT = `
  SELECT identifier.id, identifier.production_id, identifier.material_id,
         identifier.lot_id, identifier.kind, identifier.external_type,
         identifier.external_label, identifier.display_value, identifier.is_active,
         identifier.retired_at, identifier.retired_reason, identifier.created_at,
         identifier.token,
         material.name AS material_name, material.tracking_strategy,
         material_number.display_value AS material_number,
         internal_code.display_value AS internal_code,
         COALESCE(stock.expected_quantity, 0)::text AS expected_quantity,
         COALESCE(stock.in_stock_quantity, 0)::text AS in_stock_quantity,
         COALESCE(stock.checked_out_quantity, 0)::text AS checked_out_quantity,
         COALESCE(stock.maintenance_quantity, 0)::text AS maintenance_quantity
    FROM production_material_identifier identifier
    JOIN production_material material
      ON material.id=identifier.material_id AND material.production_id=identifier.production_id
    JOIN production_material_identifier material_number
      ON material_number.production_id=identifier.production_id
     AND material_number.material_id=identifier.material_id
     AND material_number.kind='material_number'
    LEFT JOIN production_material_identifier internal_code
      ON internal_code.production_id=identifier.production_id
     AND internal_code.lot_id=identifier.lot_id
     AND internal_code.kind='internal_code' AND internal_code.is_active
    LEFT JOIN LATERAL (
      SELECT
        lot.confirmed_quantity
          + COALESCE(SUM(CASE WHEN movement.to_bucket='expected' THEN movement.quantity ELSE 0 END),0)
          - COALESCE(SUM(CASE WHEN movement.from_bucket='expected' THEN movement.quantity ELSE 0 END),0)
          AS expected_quantity,
        COALESCE(SUM(CASE WHEN movement.to_bucket='in_stock' THEN movement.quantity ELSE 0 END),0)
          - COALESCE(SUM(CASE WHEN movement.from_bucket='in_stock' THEN movement.quantity ELSE 0 END),0)
          AS in_stock_quantity,
        COALESCE(SUM(CASE WHEN movement.to_bucket='checked_out' THEN movement.quantity ELSE 0 END),0)
          - COALESCE(SUM(CASE WHEN movement.from_bucket='checked_out' THEN movement.quantity ELSE 0 END),0)
          AS checked_out_quantity,
        COALESCE(SUM(CASE WHEN movement.to_bucket='maintenance' THEN movement.quantity ELSE 0 END),0)
          - COALESCE(SUM(CASE WHEN movement.from_bucket='maintenance' THEN movement.quantity ELSE 0 END),0)
          AS maintenance_quantity
        FROM production_material_stock_lot lot
        LEFT JOIN production_material_stock_movement movement ON movement.lot_id=lot.id
       WHERE lot.id=identifier.lot_id AND lot.production_id=identifier.production_id
       GROUP BY lot.id, lot.confirmed_quantity
    ) stock ON true`;

export async function resolveMaterialIdentifierByCode(
  productionId: string,
  rawCode: string,
): Promise<MaterialIdentifierResolution | "not_found" | "conflict"> {
  const generated = normalizeGeneratedMaterialCode(rawCode);
  const external = normalizeExternalMaterialCode(rawCode);
  if (!external) return "not_found";
  const { rows } = await getPool().query<ResolutionRow>(
    `${RESOLUTION_SELECT}
      WHERE identifier.production_id=$1
        AND identifier.normalized_value = ANY($2::text[])`,
    [productionId, [...new Set([generated, external])]],
  );
  if (rows.length === 0) return "not_found";
  if (rows.length > 1) return "conflict";
  return resolutionFromRow(rows[0]);
}

export async function resolveMaterialIdentifierByToken(
  token: string,
): Promise<MaterialIdentifierResolution | "not_found" | "conflict"> {
  const { rows } = await getPool().query<ResolutionRow>(
    `${RESOLUTION_SELECT} WHERE identifier.token=$1`, [token],
  );
  if (rows.length === 0) return "not_found";
  if (rows.length > 1) return "conflict";
  return resolutionFromRow(rows[0]);
}

export async function getMaterialIdentifierForImage(
  productionId: string,
  identifierId: string,
): Promise<(MaterialIdentifierResolution & { token: string | null }) | null> {
  const { rows } = await getPool().query<ResolutionRow>(
    `${RESOLUTION_SELECT}
      WHERE identifier.production_id=$1 AND identifier.id=$2`,
    [productionId, identifierId],
  );
  if (!rows[0]) return null;
  return { ...resolutionFromRow(rows[0]), token: rows[0].token };
}
