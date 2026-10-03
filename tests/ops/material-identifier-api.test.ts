import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { strFromU8, unzipSync } from "fflate";
import { GET as scanToken } from "@/app/api/material-identifiers/scan/[token]/route";
import {
  DELETE as retireIdentifier,
  POST as replaceIdentifier,
} from "@/app/api/production/[id]/material-identifiers/[identifierId]/route";
import { GET as identifierImage } from "@/app/api/production/[id]/material-identifiers/[identifierId]/image/route";
import { POST as generateLabels } from "@/app/api/production/[id]/material-identifiers/labels/route";
import { POST as resolveIdentifier } from "@/app/api/production/[id]/material-identifiers/resolve/route";
import {
  GET as listIdentifiers,
  POST as addExternalIdentifier,
} from "@/app/api/production/[id]/materials/[materialId]/lots/[lotId]/identifiers/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { selfConfirmResourceGrant } from "@/lib/perm/resource-grant-db";
import { createMaterial, listMaterialStockLots } from "@/lib/ops/material-db";
import { listMaterialIdentifiers } from "@/lib/ops/material-identifier-db";
import { cleanupProduction, makeProduction, shortId } from "../_support/factories";

let prodId: string;
let ownerId: string;
let outsiderId: string;
let viewerId: string;
let creatorId: string;
let materialId: string;
let lotId: string;

beforeAll(async () => {
  const user = async (name: string) => (await upsertFeishuUser(
    `identifier-api-${shortId()}`, name, null, false,
  )).userId;
  [ownerId, outsiderId, viewerId, creatorId] = await Promise.all([
    user("编号 owner"), user("编号 outsider"), user("编号 viewer"), user("编号 creator"),
  ]);
  ({ prodId } = await makeProduction(ownerId));
  for (const id of [ownerId, viewerId, creatorId]) await addProductionMember(prodId, id);
  await selfConfirmResourceGrant(viewerId, prodId, "material", "*", "view");
  await selfConfirmResourceGrant(creatorId, prodId, "material", "*", "create");
  const material = await createMaterial({
    productionId: prodId, name: "API 无线话筒", trackingStrategy: "serialized",
    subject: null, createdBy: ownerId,
  });
  materialId = material.id;
  lotId = (await listMaterialStockLots(materialId, prodId))[0].id;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

function request(url: string, method: string, body?: unknown, userId?: string) {
  const req = new NextRequest(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  });
  if (userId) req.cookies.set(SESSION_COOKIE, createSession({
    userId, name: "编号测试", avatarUrl: null, isAdmin: false,
  }));
  return req;
}

const lotCtx = () => ({ params: Promise.resolve({ id: prodId, materialId, lotId }) });
const productionCtx = () => ({ params: Promise.resolve({ id: prodId }) });

describe("物料标识 API 权限与结果", () => {
  it("新路由覆盖 401、非成员 403、仅持无关单枚键 403", async () => {
    const body = { type: "manufacturer_serial", value: `SN-${shortId()}` };
    expect((await addExternalIdentifier(
      request("http://localhost/api/identifiers", "POST", body), lotCtx(),
    ))!.status).toBe(401);
    expect((await addExternalIdentifier(
      request("http://localhost/api/identifiers", "POST", body, outsiderId), lotCtx(),
    ))!.status).toBe(403);
    for (const id of [viewerId, creatorId]) {
      expect((await addExternalIdentifier(
        request("http://localhost/api/identifiers", "POST", body, id), lotCtx(),
      ))!.status).toBe(403);
    }
    const internal = (await listMaterialIdentifiers(prodId, materialId, lotId))
      .find(item => item.kind === "internal_code")!;
    const labelsBody = { identifierIds: [internal.id] };
    expect((await generateLabels(
      request("http://localhost/api/labels", "POST", labelsBody), productionCtx(),
    )).status).toBe(401);
    expect((await generateLabels(
      request("http://localhost/api/labels", "POST", labelsBody, outsiderId), productionCtx(),
    ))!.status).toBe(403);
    for (const id of [viewerId, creatorId]) {
      expect((await generateLabels(
        request("http://localhost/api/labels", "POST", labelsBody, id), productionCtx(),
      )).status).toBe(403);
    }
  });

  it("查看者可列出和解析，只有当前写门允许登记、失效和生成图片", async () => {
    expect((await listIdentifiers(
      request("http://localhost/api/identifiers", "GET", undefined, viewerId), lotCtx(),
    ))!.status).toBe(200);
    const value = `厂商-${shortId()}`;
    const createdResponse = await addExternalIdentifier(
      request("http://localhost/api/identifiers", "POST", {
        type: "manufacturer_serial", value,
      }, ownerId),
      lotCtx(),
    );
    expect(createdResponse!.status).toBe(201);
    const { identifier } = await createdResponse!.json();

    const viewResolve = await resolveIdentifier(
      request("http://localhost/api/resolve", "POST", { code: value }, viewerId),
      productionCtx(),
    );
    expect(viewResolve.status).toBe(200);
    expect(await viewResolve.json()).toMatchObject({ status: "valid" });
    expect((await resolveIdentifier(
      request("http://localhost/api/resolve", "POST", { code: value }, creatorId),
      productionCtx(),
    )).status).toBe(403);
    expect((await resolveIdentifier(
      request("http://localhost/api/resolve", "POST", { code: value, action: "manage" }, viewerId),
      productionCtx(),
    )).status).toBe(403);

    const internal = (await listMaterialIdentifiers(prodId, materialId, lotId))
      .find(item => item.kind === "internal_code")!;
    const imageCtx = { params: Promise.resolve({ id: prodId, identifierId: internal.id }) };
    expect((await identifierImage(
      request("http://localhost/api/image?type=qr&format=svg", "GET", undefined, viewerId),
      imageCtx,
    )).status).toBe(403);
    const image = await identifierImage(
      request("http://localhost/api/image?type=qr&format=svg", "GET", undefined, ownerId),
      imageCtx,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toContain("image/svg+xml");

    const replaceCtx = { params: Promise.resolve({ id: prodId, identifierId: internal.id }) };
    expect((await replaceIdentifier(
      request("http://localhost/api/identifier", "POST", { reason: "无权限换码" }, viewerId),
      replaceCtx,
    ))!.status).toBe(403);

    const retireCtx = { params: Promise.resolve({ id: prodId, identifierId: identifier.id }) };
    expect((await retireIdentifier(
      request("http://localhost/api/identifier", "DELETE", { reason: "换码" }, viewerId),
      retireCtx,
    ))!.status).toBe(403);
    expect((await retireIdentifier(
      request("http://localhost/api/identifier", "DELETE", { reason: "换码" }, ownerId),
      retireCtx,
    ))!.status).toBe(200);
    const inactive = await resolveIdentifier(
      request("http://localhost/api/resolve", "POST", { code: value }, viewerId),
      productionCtx(),
    );
    expect(await inactive.json()).toMatchObject({ status: "inactive" });
  });

  it("QR token 路由在登录和项目访问后返回同一实体", async () => {
    const { rows: [row] } = await (await import("@/lib/pg")).getPool().query<{ token: string }>(
      `SELECT token FROM production_material_identifier
        WHERE production_id=$1 AND lot_id=$2 AND kind='internal_code'`,
      [prodId, lotId],
    );
    const ctx = { params: Promise.resolve({ token: row.token }) };
    expect((await scanToken(
      request(`http://localhost/api/material-identifiers/scan/${row.token}`, "GET"), ctx,
    )).status).toBe(401);
    expect((await scanToken(
      request(`http://localhost/api/material-identifiers/scan/${row.token}`, "GET", undefined, outsiderId), ctx,
    )).status).toBe(403);
    const response = await scanToken(
      request(`http://localhost/api/material-identifiers/scan/${row.token}`, "GET", undefined, viewerId), ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ identifier: { lotId } });
  });

  it("多个内部码可生成带可读编号文件名的 ZIP 与打印页", async () => {
    const second = await createMaterial({
      productionId: prodId, name: "API 监听耳机", trackingStrategy: "serialized",
      subject: null, createdBy: ownerId,
    });
    const secondLot = (await listMaterialStockLots(second.id, prodId))[0];
    const firstInternal = (await listMaterialIdentifiers(prodId, materialId, lotId))
      .find(item => item.kind === "internal_code")!;
    const secondInternal = (await listMaterialIdentifiers(prodId, second.id, secondLot.id))
      .find(item => item.kind === "internal_code")!;
    const identifierIds = [firstInternal.id, secondInternal.id];
    const archiveResponse = await generateLabels(
      request("http://localhost/api/labels", "POST", {
        identifierIds, type: "code128", format: "svg", size: "small", output: "zip",
      }, ownerId),
      productionCtx(),
    );
    expect(archiveResponse.status).toBe(200);
    expect(archiveResponse.headers.get("content-type")).toBe("application/zip");
    const archive = unzipSync(new Uint8Array(await archiveResponse.arrayBuffer()));
    const names = Object.keys(archive);
    expect(names).toHaveLength(2);
    expect(names.every(name => name.includes("M-") && name.endsWith("-条码.svg"))).toBe(true);
    expect(names.every(name => strFromU8(archive[name]).includes("<svg"))).toBe(true);

    const printResponse = await generateLabels(
      request("http://localhost/api/labels", "POST", {
        identifierIds, type: "qr", output: "print",
      }, ownerId),
      productionCtx(),
    );
    expect(printResponse.headers.get("content-type")).toContain("text/html");
    const html = await printResponse.text();
    expect(html.match(/<article class="label">/g)).toHaveLength(2);
    expect(html).toContain(firstInternal.displayValue);
    expect(html).toContain(secondInternal.displayValue);
  });
});
