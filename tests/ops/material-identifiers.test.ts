import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { getPool } from "@/lib/pg";
import {
  createMaterialNumberInTx,
  createExternalMaterialIdentifier,
  listMaterialIdentifiers,
  MaterialIdentifierError,
  resolveMaterialIdentifierByCode,
  resolveMaterialIdentifierByToken,
  replaceMaterialStockIdentifier,
  retireMaterialIdentifier,
} from "@/lib/ops/material-identifier-db";
import {
  createMaterial,
  createMaterialStockLot,
  listMaterialStockLots,
} from "@/lib/ops/material-db";
import {
  formatMaterialNumber,
  formatMaterialStockCode,
  normalizeGeneratedMaterialCode,
} from "@/lib/ops/material-identifier-types";
import { renderMaterialCodeImage } from "@/lib/ops/material-label";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let ownerId: string;
let prodId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(
    `identifier-owner-${shortId()}`, `编号测试${shortId()}`, null, false,
  )).userId;
  ({ prodId } = await makeProduction(ownerId));
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("可读编号格式", () => {
  it("物料号与同物料实物/批次号分层且带校验位", () => {
    expect(formatMaterialNumber(1)).toBe("M-0001-7");
    expect(formatMaterialStockCode(1, 1, "serialized")).toBe("M-0001-S001-6");
    expect(formatMaterialStockCode(1, 2, "batch")).toBe("M-0001-B002-3");
    expect(normalizeGeneratedMaterialCode(" m-0001-s001-6 ")).toBe("M0001S0016");
  });
});

describe("两级事务计数器", () => {
  it("serialized 同物料逐件连续编号，其他物料使用自己的 S001", async () => {
    const first = await createMaterial({
      productionId: prodId, name: "无线话筒", trackingStrategy: "serialized",
      quantity: 3, subject: null, createdBy: ownerId,
    });
    const firstLots = await listMaterialStockLots(first.id, prodId);
    const firstCodes = (await listMaterialIdentifiers(prodId, first.id))
      .filter(identifier => identifier.kind === "internal_code")
      .map(identifier => identifier.displayValue);
    expect(firstLots).toHaveLength(3);
    expect(firstCodes).toEqual([
      `${first.number.slice(0, -1)}S001-6`,
      `${first.number.slice(0, -1)}S002-3`,
      `${first.number.slice(0, -1)}S003-0`,
    ]);

    const second = await createMaterial({
      productionId: prodId, name: "椅子", trackingStrategy: "serialized",
      quantity: 1, subject: null, createdBy: ownerId,
    });
    const [secondCode] = (await listMaterialIdentifiers(prodId, second.id))
      .filter(identifier => identifier.kind === "internal_code");
    expect(secondCode.displayValue).toMatch(/-S001-\d$/);
  });

  it("同一物料并发新增 lot 不重号且连续", async () => {
    const material = await createMaterial({
      productionId: prodId, name: "对讲机", trackingStrategy: "serialized",
      subject: null, createdBy: ownerId,
    });
    await Promise.all(Array.from({ length: 8 }, () => createMaterialStockLot({
      productionId: prodId, materialId: material.id, confirmedQuantity: 1,
      createdBy: ownerId,
    })));
    const serials = (await listMaterialIdentifiers(prodId, material.id))
      .filter(identifier => identifier.kind === "internal_code")
      .map(identifier => Number(identifier.displayValue.match(/-S(\d+)-/)?.[1]))
      .sort((a, b) => a - b);
    expect(serials).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("回滚的事务不消耗物料号", async () => {
    const { prodId: rollbackProd } = await makeProduction(ownerId);
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const materialId = `mt_rollback${shortId()}`;
      await client.query(
        `INSERT INTO production_material(id, production_id, name, created_by)
         VALUES ($1,$2,'会回滚的物料',$3)`,
        [materialId, rollbackProd, ownerId],
      );
      await createMaterialNumberInTx(client, {
        productionId: rollbackProd, materialId, createdBy: ownerId,
      });
      await client.query("ROLLBACK");
      const committed = await createMaterial({
        productionId: rollbackProd, name: "真正提交的物料", subject: null, createdBy: ownerId,
      });
      expect(committed.number).toBe("M-0001-7");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await cleanupProduction(rollbackProd).catch(() => {});
    }
  });
});

describe("外部标识、历史占用与统一解析", () => {
  it("内部码和多个外部码定位同一实物，失效后仍占用", async () => {
    const material = await createMaterial({
      productionId: prodId, name: "租赁电脑", trackingStrategy: "serialized",
      sourceType: "rented", sourceLabel: "设备租赁方", returnDueAt: new Date(Date.now() + 86_400_000),
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    const manufacturer = await createExternalMaterialIdentifier({
      productionId: prodId, materialId: material.id, lotId: lot.id,
      externalType: "manufacturer_serial", value: "SN-ab-001", createdBy: ownerId,
    });
    const sourceAsset = await createExternalMaterialIdentifier({
      productionId: prodId, materialId: material.id, lotId: lot.id,
      externalType: "source_asset", value: "出租-7788", createdBy: ownerId,
    });
    const internal = (await listMaterialIdentifiers(prodId, material.id, lot.id))
      .find(identifier => identifier.kind === "internal_code")!;
    for (const code of [internal.displayValue, "sn ab 001", sourceAsset.displayValue]) {
      const result = await resolveMaterialIdentifierByCode(prodId, code);
      expect(result).not.toBe("not_found");
      expect(result).not.toBe("conflict");
      if (typeof result !== "string") expect(result.identifier.lotId).toBe(lot.id);
    }

    await retireMaterialIdentifier({
      productionId: prodId, identifierId: manufacturer.id,
      retiredBy: ownerId, reason: "出租方换码",
    });
    const retired = await resolveMaterialIdentifierByCode(prodId, "SN-AB-001");
    expect(typeof retired === "string" ? retired : retired.status).toBe("inactive");
    await expect(createExternalMaterialIdentifier({
      productionId: prodId, materialId: material.id, lotId: lot.id,
      externalType: "existing_barcode", value: "sn-ab-001", createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "duplicate_code" } satisfies Partial<MaterialIdentifierError>);
    await expect(createExternalMaterialIdentifier({
      productionId: prodId, materialId: material.id, lotId: lot.id,
      externalType: "manufacturer_serial", value: "SN\n控制字符", createdBy: ownerId,
    })).rejects.toMatchObject({ reason: "bad_code" });
  });

  it("内部码换码后旧码明确失效，新码继续解析同一实物且序号不复用", async () => {
    const material = await createMaterial({
      productionId: prodId, name: "换码腰包", trackingStrategy: "serialized",
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    const original = (await listMaterialIdentifiers(prodId, material.id, lot.id))
      .find(identifier => identifier.kind === "internal_code")!;
    const changed = await replaceMaterialStockIdentifier({
      productionId: prodId, identifierId: original.id,
      replacedBy: ownerId, reason: "原标签损坏",
    });
    expect(changed.retired).toMatchObject({ id: original.id, isActive: false });
    expect(changed.replacement.displayValue).toMatch(/-S002-\d$/);
    const oldResult = await resolveMaterialIdentifierByCode(prodId, original.displayValue);
    const newResult = await resolveMaterialIdentifierByCode(prodId, changed.replacement.displayValue);
    expect(typeof oldResult === "string" ? oldResult : oldResult.status).toBe("inactive");
    expect(typeof newResult === "string" ? newResult : newResult.identifier.lotId).toBe(lot.id);
  });

  it("物料编号本身可定位物料，不因没有 lot 被误报为不可用", async () => {
    const material = await createMaterial({
      productionId: prodId, name: "整批定位物料", subject: null, createdBy: ownerId,
    });
    const result = await resolveMaterialIdentifierByCode(prodId, material.number);
    expect(typeof result === "string" ? result : result.status).toBe("valid");
    if (typeof result !== "string") expect(result.identifier.lotId).toBeNull();
  });

  it("QR token 不含项目、物料或状态，并解析到与内部码相同的 lot", async () => {
    const material = await createMaterial({
      productionId: prodId, name: "扫码灯具", trackingStrategy: "serialized",
      subject: null, createdBy: ownerId,
    });
    const [lot] = await listMaterialStockLots(material.id, prodId);
    const { rows: [row] } = await getPool().query<{ token: string; display_value: string }>(
      `SELECT token, display_value FROM production_material_identifier
        WHERE production_id=$1 AND lot_id=$2 AND kind='internal_code'`,
      [prodId, lot.id],
    );
    expect(row.token).not.toContain(prodId);
    expect(row.token).not.toContain(material.id);
    expect(row.token).not.toMatch(/expected|stock|maintenance/);
    const byToken = await resolveMaterialIdentifierByToken(row.token);
    const byCode = await resolveMaterialIdentifierByCode(prodId, row.display_value);
    expect(typeof byToken === "string" ? byToken : byToken.identifier.lotId).toBe(lot.id);
    expect(typeof byCode === "string" ? byCode : byCode.identifier.lotId).toBe(lot.id);
  });
});

describe("码图片", () => {
  it("同一 payload 可稳定生成 SVG 与 PNG", async () => {
    const first = await renderMaterialCodeImage({
      symbology: "qr", format: "svg", payload: "https://example.test/scan/token", size: "medium",
    });
    const second = await renderMaterialCodeImage({
      symbology: "qr", format: "svg", payload: "https://example.test/scan/token", size: "medium",
    });
    expect(first.body).toBe(second.body);
    expect(String(first.body)).toContain("<svg");
    const png = await renderMaterialCodeImage({
      symbology: "code128", format: "png", payload: "M-0001-S001-6", size: "medium",
    });
    expect(Buffer.isBuffer(png.body)).toBe(true);
    expect((png.body as Buffer).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
