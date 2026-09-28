import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/productions/route";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { createProduction } from "@/lib/production/production-db";
import { cleanupProduction, shortId } from "../_support/factories";

describe("PATCH /api/productions — 个人项目排序", () => {
  const productionIds = [`api-order-${shortId()}`, `api-order-${shortId()}`];
  let userId = "";
  let session = "";

  beforeAll(async () => {
    userId = (await upsertFeishuUser(`api-order-${shortId()}`, "API 排序用户", null, false)).userId;
    session = createSession({ userId, name: "API 排序用户", avatarUrl: null, isAdmin: false });
    for (const [index, id] of productionIds.entries()) {
      await createProduction(id, `API 排序项目 ${index + 1}`, userId);
    }
  });

  afterAll(async () => {
    for (const id of productionIds) await cleanupProduction(id).catch(() => {});
  });

  function request(body: unknown, withSession = true): NextRequest {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (withSession) headers.set("Cookie", `${SESSION_COOKIE}=${session}`);
    return new NextRequest("http://localhost/api/productions", {
      method: "PATCH", headers, body: JSON.stringify(body),
    });
  }

  it("未登录返回 401", async () => {
    expect((await PATCH(request({}, false))).status).toBe(401);
  });

  it("相对位置形状错误返回 400", async () => {
    expect((await PATCH(request({ productionId: productionIds[0], place: { anchorId: productionIds[1], side: "middle" } }))).status).toBe(400);
  });

  it("不能用自己不可见的项目作锚点", async () => {
    const outsider = (await upsertFeishuUser(`api-order-other-${shortId()}`, "其他 owner", null, false)).userId;
    const foreignId = `api-order-foreign-${shortId()}`;
    await createProduction(foreignId, "不可见项目", outsider);
    try {
      const res = await PATCH(request({
        productionId: productionIds[0], place: { anchorId: foreignId, side: "before" },
      }));
      expect(res.status).toBe(409);
    } finally {
      await cleanupProduction(foreignId).catch(() => {});
    }
  });

  it("普通登录用户可调整自己的项目顺序", async () => {
    const res = await PATCH(request({
      productionId: productionIds[1], place: { anchorId: productionIds[0], side: "before" },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
