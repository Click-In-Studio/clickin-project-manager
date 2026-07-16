import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { TEST_USER, PROD_PLANET } from "./helpers";

import {
  GET as listViewsHandler,
  POST as createViewHandler,
} from "@/app/api/production/[id]/scene-table-views/route";
import {
  PATCH as updateViewHandler,
  DELETE as deleteViewHandler,
} from "@/app/api/production/[id]/scene-table-views/[viewId]/route";
import {
  PATCH as setDefaultHandler,
} from "@/app/api/production/[id]/scene-table-views/[viewId]/default/route";

// ── Session helpers ────────────────────────────────────────────────────────────

function adminSession() {
  return createSession({ openId: TEST_USER, name: "管理员", avatarUrl: null, isAdmin: true });
}
// Another admin-level user — passes permission checks but different open_id.
function otherSession() {
  return createSession({ openId: "other-test-user", name: "他人", avatarUrl: null, isAdmin: true });
}

function req(
  url: string,
  opts: { session?: string; method?: string; body?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    body: opts.body,
    headers,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

const createdIds: string[] = [];
afterAll(async () => {
  const { getPool } = await import("@/lib/pg");
  if (createdIds.length > 0) {
    await getPool().query(
      `DELETE FROM scene_table_view_config WHERE id = ANY($1)`,
      [createdIds],
    );
  }
});

// ── Auth guard ─────────────────────────────────────────────────────────────────

describe("auth guard — GET /api/production/[id]/scene-table-views", () => {
  it("no cookie → 401", async () => {
    const res = await listViewsHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views`),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });
});

describe("auth guard — POST /api/production/[id]/scene-table-views", () => {
  it("no cookie → 401", async () => {
    const res = await createViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views`, {
        method: "POST",
        body: JSON.stringify({ name: "test" }),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(401);
  });
});

describe("auth guard — PATCH /api/production/[id]/scene-table-views/[viewId]", () => {
  it("no cookie → 401", async () => {
    const res = await updateViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/nonexistent`, { method: "PATCH" }),
      ctx({ id: PROD_PLANET, viewId: "nonexistent" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("auth guard — DELETE /api/production/[id]/scene-table-views/[viewId]", () => {
  it("no cookie → 401", async () => {
    const res = await deleteViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/nonexistent`, { method: "DELETE" }),
      ctx({ id: PROD_PLANET, viewId: "nonexistent" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("auth guard — PATCH /api/production/[id]/scene-table-views/[viewId]/default", () => {
  it("no cookie → 401", async () => {
    const res = await setDefaultHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/nonexistent/default`, { method: "PATCH" }),
      ctx({ id: PROD_PLANET, viewId: "nonexistent" }),
    );
    expect(res.status).toBe(401);
  });
});

// ── Input validation ───────────────────────────────────────────────────────────

describe("POST /api/production/[id]/scene-table-views — validation", () => {
  it("empty name → 400", async () => {
    const res = await createViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views`, {
        method: "POST",
        body: JSON.stringify({ name: "  " }),
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(400);
  });
});

// ── Happy paths ────────────────────────────────────────────────────────────────

describe("scene-table-views CRUD happy path", () => {
  let viewId: string;

  it("GET returns empty list initially", async () => {
    // Clean slate: delete any leftover views for TEST_USER on PROD_PLANET
    const { getPool } = await import("@/lib/pg");
    await getPool().query(
      `DELETE FROM scene_table_view_config WHERE open_id = $1 AND production_id = $2`,
      [TEST_USER, PROD_PLANET],
    );

    const res = await listViewsHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views`, { session: adminSession() }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.views).toEqual([]);
  });

  it("POST creates a view", async () => {
    const res = await createViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views`, {
        method: "POST",
        body: JSON.stringify({
          name: "我的视图",
          config: { columnOrder: ["num", "name"], visibleColumns: ["num", "name"], columnWidths: {} },
          isDefault: false,
        }),
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("我的视图");
    expect(body.isDefault).toBe(false);
    viewId = body.id;
    createdIds.push(viewId);
  });

  it("GET lists the created view", async () => {
    const res = await listViewsHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views`, { session: adminSession() }),
      ctx({ id: PROD_PLANET }),
    );
    const body = await res.json();
    expect(body.views).toHaveLength(1);
    expect(body.views[0].id).toBe(viewId);
  });

  it("PATCH updates name and config", async () => {
    const res = await updateViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/${viewId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "改名后视图" }),
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET, viewId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("改名后视图");
  });

  it("PATCH /default marks view as default", async () => {
    const res = await setDefaultHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/${viewId}/default`, {
        method: "PATCH",
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET, viewId }),
    );
    expect(res.status).toBe(200);
    const listed = await listViewsHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views`, { session: adminSession() }),
      ctx({ id: PROD_PLANET }),
    );
    const listBody = await listed.json();
    expect(listBody.views[0].isDefault).toBe(true);
  });

  it("DELETE removes the view", async () => {
    const res = await deleteViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/${viewId}`, {
        method: "DELETE",
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET, viewId }),
    );
    expect(res.status).toBe(200);
    createdIds.splice(createdIds.indexOf(viewId), 1);
  });
});

// ── Ownership guard ────────────────────────────────────────────────────────────

describe("ownership guard — cannot modify another user's view", () => {
  let ownedViewId: string;

  it("setup: create view as TEST_USER", async () => {
    const res = await createViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views`, {
        method: "POST",
        body: JSON.stringify({ name: "他人视图", isDefault: false }),
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET }),
    );
    const body = await res.json();
    ownedViewId = body.id;
    createdIds.push(ownedViewId);
  });

  it("PATCH by other user → 403", async () => {
    const res = await updateViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/${ownedViewId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "偷改" }),
        session: otherSession(),
      }),
      ctx({ id: PROD_PLANET, viewId: ownedViewId }),
    );
    expect(res.status).toBe(403);
  });

  it("DELETE by other user → 403", async () => {
    const res = await deleteViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/${ownedViewId}`, {
        method: "DELETE",
        session: otherSession(),
      }),
      ctx({ id: PROD_PLANET, viewId: ownedViewId }),
    );
    expect(res.status).toBe(403);
  });

  it("PATCH /default by other user → 403", async () => {
    const res = await setDefaultHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/${ownedViewId}/default`, {
        method: "PATCH",
        session: otherSession(),
      }),
      ctx({ id: PROD_PLANET, viewId: ownedViewId }),
    );
    expect(res.status).toBe(403);
  });
});

// ── 404 for non-existent view ──────────────────────────────────────────────────

describe("404 for non-existent view", () => {
  it("PATCH non-existent → 404", async () => {
    const res = await updateViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/stv_does_not_exist`, {
        method: "PATCH",
        body: JSON.stringify({ name: "x" }),
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET, viewId: "stv_does_not_exist" }),
    );
    expect(res.status).toBe(404);
  });

  it("DELETE non-existent → 404", async () => {
    const res = await deleteViewHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/stv_does_not_exist`, {
        method: "DELETE",
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET, viewId: "stv_does_not_exist" }),
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /default non-existent → 404", async () => {
    const res = await setDefaultHandler(
      req(`/api/production/${PROD_PLANET}/scene-table-views/stv_does_not_exist/default`, {
        method: "PATCH",
        session: adminSession(),
      }),
      ctx({ id: PROD_PLANET, viewId: "stv_does_not_exist" }),
    );
    expect(res.status).toBe(404);
  });
});
