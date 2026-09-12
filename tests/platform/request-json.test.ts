import { describe, expect, it } from "vitest";
import { readJsonObject } from "@/lib/request-json";

describe("readJsonObject", () => {
  it("畸形 JSON 返回 400，不抛成 500", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    const result = await readJsonObject(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({ error: "请求体必须是有效 JSON" });
    }
  });

  it.each([null, [], "text", 1])("非对象 JSON %# 返回 400", async value => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const result = await readJsonObject(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("对象请求体原样返回", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "对光组" }),
    });
    await expect(readJsonObject(req)).resolves.toEqual({ ok: true, value: { name: "对光组" } });
  });
});
