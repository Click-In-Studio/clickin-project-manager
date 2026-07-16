import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { deleteProduction } from "@/lib/db";
import { TEST_USER } from "./helpers";

import { POST as createProductionHandler } from "@/app/api/productions/route";

function adminSession() {
  return createSession({ openId: TEST_USER, name: "管理员", avatarUrl: null, isAdmin: true });
}

function req(idemKey?: string): NextRequest {
  const headers = new Headers();
  headers.set("cookie", `${SESSION_COOKIE}=${adminSession()}`);
  if (idemKey) headers.set("Idempotency-Key", idemKey);
  return new NextRequest("http://localhost/api/productions", {
    method: "POST",
    body: JSON.stringify({ name: "幂等测试演出" }),
    headers,
  });
}

const createdIds: string[] = [];
afterAll(async () => {
  for (const id of createdIds) await deleteProduction(id).catch(() => {});
});

describe("idempotency — serial retries", () => {
  it("same key twice → same id, no duplicate row", async () => {
    const key = randomUUID();

    const r1 = await createProductionHandler(req(key));
    expect(r1.status).toBe(201);
    const { id: id1 } = await r1.json();
    createdIds.push(id1);

    const r2 = await createProductionHandler(req(key));
    expect(r2.status).toBe(201);
    const { id: id2 } = await r2.json();

    expect(id2).toBe(id1);

    const { getPool } = await import("@/lib/pg");
    const { rows } = await getPool().query(
      "SELECT COUNT(*) AS n FROM production WHERE id = $1",
      [id1],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("different keys → different ids, two rows", async () => {
    const r1 = await createProductionHandler(req(randomUUID()));
    const r2 = await createProductionHandler(req(randomUUID()));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const { id: id1 } = await r1.json();
    const { id: id2 } = await r2.json();
    createdIds.push(id1, id2);
    expect(id1).not.toBe(id2);
  });

  it("no key → always creates (no idempotency)", async () => {
    const r1 = await createProductionHandler(req());
    const r2 = await createProductionHandler(req());
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const { id: id1 } = await r1.json();
    const { id: id2 } = await r2.json();
    createdIds.push(id1, id2);
    expect(id1).not.toBe(id2);
  });
});

describe("idempotency — concurrent requests (TOCTOU regression)", () => {
  it("two concurrent requests with same key → same id, single DB row", async () => {
    const key = randomUUID();

    // Fire both without awaiting the first — they interleave on await boundaries.
    const [r1, r2] = await Promise.all([
      createProductionHandler(req(key)),
      createProductionHandler(req(key)),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const { id: id1 } = await r1.json();
    const { id: id2 } = await r2.json();
    createdIds.push(id1);

    expect(id1).toBe(id2);

    const { getPool } = await import("@/lib/pg");
    const { rows } = await getPool().query(
      "SELECT COUNT(*) AS n FROM production WHERE name = '幂等测试演出' AND id = $1",
      [id1],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
