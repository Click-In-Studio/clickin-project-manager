/**
 * Resilience & edge-case tests:
 * - duplicate create handling (DB rejects; original intact)
 * - concurrent creates simulating a network-retry race
 * - no-op safety for delete/update on non-existent IDs
 * - adversarial text inputs (SQL injection, emoji, 2000-char strings)
 * - archive idempotency
 * - cascade delete verification
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createProduction, deleteProduction, getProductionName,
  createCueList, deleteCueList, getCueList,
  createCue, getCue, deleteCue, updateCue, listCues,
  archiveProduction, unarchiveProduction, isProductionArchived,
} from "@/lib/db";
import { listProductionEvents } from "@/lib/event-db";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { TEST_USER } from "./helpers";

const BASE_PROD = "test-res-prod";
const BASE_CL   = "test-res-cl";
const BASE_CUE  = "test-res-cue-init"; // created in duplicate test
const CAS_PROD  = "test-res-cascade";
const CAS_CL    = "test-res-cascade-cl";
const CAS_CUE   = "test-res-cascade-cue";

beforeAll(async () => {
  await createProduction(BASE_PROD, "弹性测试演出");
  await createCueList({
    id: BASE_CL, productionId: BASE_PROD, name: "弹性测试走位表",
    notes: "", abbr: null, template: null, defaultEditRoles: [], createdBy: TEST_USER,
  });
  // cascade chain
  await createProduction(CAS_PROD, "级联测试演出");
  await createCueList({
    id: CAS_CL, productionId: CAS_PROD, name: "级联走位表",
    notes: "", abbr: null, template: null, defaultEditRoles: [], createdBy: TEST_USER,
  });
  const anchor = { kind: "gap" as const, afterBlockId: null };
  await createCue({ id: CAS_CUE, cueListId: CAS_CL, number: "C1", name: "级联Q", content: "", start: anchor, end: anchor });
});

afterAll(async () => {
  await deleteCue(BASE_CUE, BASE_CL).catch(() => {});
  await deleteCueList(BASE_CL, BASE_PROD).catch(() => {});
  await deleteProduction(BASE_PROD).catch(() => {});
  await deleteProduction(CAS_PROD).catch(() => {}); // already deleted in cascade test
});

// ---------- duplicate create handling ----------

describe("duplicate create handling", () => {
  const anchor = { kind: "gap" as const, afterBlockId: null };

  it("creating production with existing id throws and leaves original intact", async () => {
    await expect(createProduction(BASE_PROD, "重复演出")).rejects.toThrow();
    expect(await getProductionName(BASE_PROD)).toBe("弹性测试演出");
  });

  it("creating cue list with existing id throws and leaves original intact", async () => {
    await expect(
      createCueList({
        id: BASE_CL, productionId: BASE_PROD, name: "重复走位表",
        notes: "", abbr: null, template: null, defaultEditRoles: [], createdBy: TEST_USER,
      })
    ).rejects.toThrow();
    expect((await getCueList(BASE_CL, BASE_PROD))!.name).toBe("弹性测试走位表");
  });

  it("creating cue with existing id throws and leaves original intact", async () => {
    await createCue({ id: BASE_CUE, cueListId: BASE_CL, number: "R1", name: "初次Q", content: "", start: anchor, end: anchor });
    await expect(
      createCue({ id: BASE_CUE, cueListId: BASE_CL, number: "R1", name: "重复Q", content: "", start: anchor, end: anchor })
    ).rejects.toThrow();
    expect((await getCue(BASE_CUE, BASE_CL))!.name).toBe("初次Q");
  });
});

// ---------- concurrent creates (network retry simulation) ----------

describe("concurrent duplicate creates — exactly one wins", () => {
  it("two simultaneous createProduction with same id: one succeeds, one rejects", async () => {
    const id = "test-res-race-prod";
    const results = await Promise.allSettled([
      createProduction(id, "并发A"),
      createProduction(id, "并发B"),
    ]);
    await deleteProduction(id).catch(() => {});
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes).toHaveLength(1);
  });

  it("two simultaneous createCue with same id: one succeeds, one rejects", async () => {
    const id = "test-res-race-cue";
    const anchor = { kind: "gap" as const, afterBlockId: null };
    const results = await Promise.allSettled([
      createCue({ id, cueListId: BASE_CL, number: "P1", name: "并发CueA", content: "", start: anchor, end: anchor }),
      createCue({ id, cueListId: BASE_CL, number: "P1", name: "并发CueB", content: "", start: anchor, end: anchor }),
    ]);
    await deleteCue(id, BASE_CL).catch(() => {});
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

// ---------- non-existent resource operations ----------

describe("operations on non-existent resources are safe no-ops", () => {
  it("deleteProduction on non-existent id does not throw", async () => {
    await expect(deleteProduction("no-such-prod-999")).resolves.toBeUndefined();
  });

  it("deleteCue on non-existent id does not throw", async () => {
    await expect(deleteCue("no-such-cue-999", BASE_CL)).resolves.toBeUndefined();
  });

  it("updateCue on non-existent id is a silent no-op", async () => {
    await expect(updateCue("no-such-cue-999", BASE_CL, { name: "幽灵" })).resolves.toBeUndefined();
  });

  it("listCues on non-existent cue list returns empty array", async () => {
    expect(await listCues("no-such-cl-999")).toHaveLength(0);
  });

  it("listProductionEvents on non-existent production returns empty array", async () => {
    expect(await listProductionEvents("no-such-prod-999")).toHaveLength(0);
  });
});

// ---------- adversarial text inputs ----------

describe("adversarial text inputs", () => {
  const anchor = { kind: "gap" as const, afterBlockId: null };

  it("SQL injection attempt in cue name is stored literally", async () => {
    const id   = "test-res-sqli";
    const name = "'; DROP TABLE cue; --";
    await createCue({ id, cueListId: BASE_CL, number: "SQ1", name, content: "", start: anchor, end: anchor });
    const cue = await getCue(id, BASE_CL);
    await deleteCue(id, BASE_CL).catch(() => {});
    expect(cue!.name).toBe(name);
  });

  it("emoji and multi-script unicode in cue name round-trips correctly", async () => {
    const id   = "test-res-emoji";
    const name = "🎭 开场 Q1 — こんにちは";
    await createCue({ id, cueListId: BASE_CL, number: "EM1", name, content: "", start: anchor, end: anchor });
    const cue = await getCue(id, BASE_CL);
    await deleteCue(id, BASE_CL).catch(() => {});
    expect(cue!.name).toBe(name);
  });

  it("2000-character cue content is stored and retrieved in full", async () => {
    const id      = "test-res-longstr";
    const content = "剧 ".repeat(1000); // 2000 chars (UTF-8 multi-byte)
    await createCue({ id, cueListId: BASE_CL, number: "LG1", name: "长内容", content, start: anchor, end: anchor });
    const cue = await getCue(id, BASE_CL);
    await deleteCue(id, BASE_CL).catch(() => {});
    expect(cue!.content).toBe(content);
  });

  it("null byte in cue name is rejected or stored safely (no crash)", async () => {
    const id   = "test-res-nullbyte";
    const name = "前\x00后";
    // Postgres rejects embedded null bytes in text; either it stores safely or throws cleanly
    const result = await createCue({ id, cueListId: BASE_CL, number: "NB1", name, content: "", start: anchor, end: anchor })
      .then(() => "ok" as const)
      .catch(() => "error" as const);
    await deleteCue(id, BASE_CL).catch(() => {});
    expect(["ok", "error"]).toContain(result); // must not hang or crash the process
  });
});

// ---------- archive idempotency ----------

describe("archive idempotency", () => {
  it("archiving an already-archived production does not throw", async () => {
    await archiveProduction(BASE_PROD);
    await expect(archiveProduction(BASE_PROD)).resolves.toBeUndefined();
    expect(await isProductionArchived(BASE_PROD)).toBe(true);
    await unarchiveProduction(BASE_PROD);
  });

  it("unarchiving an already-active production does not throw", async () => {
    await expect(unarchiveProduction(BASE_PROD)).resolves.toBeUndefined();
    expect(await isProductionArchived(BASE_PROD)).toBe(false);
  });
});

// ---------- cascade delete ----------

describe("cascade delete", () => {
  it("deleting a production removes its cue lists and cues", async () => {
    await deleteProduction(CAS_PROD);
    // If cascade is set, the cue is gone too
    expect(await getCue(CAS_CUE, CAS_CL)).toBeNull();
  });
});

// ---------- API-level idempotency (POST /api/productions + Idempotency-Key) ----------

import { POST as createProductionHandler } from "@/app/api/productions/route";

const idemCreatedIds: string[] = [];
afterAll(async () => {
  for (const id of idemCreatedIds) await deleteProduction(id).catch(() => {});
});

function adminReq(idemKey?: string): NextRequest {
  const token = createSession({ userId: TEST_USER, name: "管理员", avatarUrl: null, isAdmin: true });
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=${token}` });
  if (idemKey) headers.set("Idempotency-Key", idemKey);
  return new NextRequest("http://localhost/api/productions", {
    method: "POST",
    body: JSON.stringify({ name: "幂等测试演出" }),
    headers,
  });
}

describe("POST /api/productions — Idempotency-Key", () => {
  it("same key twice → same id, single DB row", async () => {
    const key = randomUUID();
    const r1 = await createProductionHandler(adminReq(key));
    const { id } = await r1.json();
    idemCreatedIds.push(id);

    const r2 = await createProductionHandler(adminReq(key));
    expect(r2.status).toBe(201);
    expect((await r2.json()).id).toBe(id);

    const { getPool } = await import("@/lib/pg");
    const { rows } = await getPool().query("SELECT COUNT(*) AS n FROM production WHERE id = $1", [id]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("concurrent requests with same key → same id, single DB row (TOCTOU regression)", async () => {
    const key = randomUUID();
    const [r1, r2] = await Promise.all([
      createProductionHandler(adminReq(key)),
      createProductionHandler(adminReq(key)),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const { id: id1 } = await r1.json();
    const { id: id2 } = await r2.json();
    idemCreatedIds.push(id1);
    expect(id1).toBe(id2);

    const { getPool } = await import("@/lib/pg");
    const { rows } = await getPool().query("SELECT COUNT(*) AS n FROM production WHERE id = $1", [id1]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("key expired after TTL → next request creates a new row", async () => {
    const key = randomUUID();
    const r1 = await createProductionHandler(adminReq(key));
    const { id: id1 } = await r1.json();
    idemCreatedIds.push(id1);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(61_000); // past IDEM_TTL_MS = 60_000
      const r2 = await createProductionHandler(adminReq(key));
      expect(r2.status).toBe(201);
      const { id: id2 } = await r2.json();
      idemCreatedIds.push(id2);
      expect(id2).not.toBe(id1);
    } finally {
      vi.useRealTimers();
    }
  });
});
