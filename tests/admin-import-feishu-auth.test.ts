/**
 * /api/admin/import-feishu 鉴权回归（2026-08-18）。
 *
 * 事故：同目录另三条 admin 路由（bot-testers、bot-testers/[openId]、sync-feishu-users）
 * 都查 session + isAdmin，只有 import-feishu 一条**完全不鉴权**——仓库里没有
 * middleware.ts 兜底，于是任何人都能 POST 进来建一个演出并把任意飞书 bitable
 * 导进库；建出来的演出还不带 owner（createProduction 当时 owner 可选），
 * 正是线上无主演出的来源。
 *
 * 两层：
 *   ① 鉴权：未登录 401 / 非 admin 403（都拦在任何飞书网络调用之前）
 *   ② 棘轮：app/api/admin/ 下每条路由的每个写方法都必须查 session 与 isAdmin
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/import-feishu/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { TEST_USER } from "./helpers";

function makeReq(session: { userId: string; isAdmin: boolean } | null): NextRequest {
  const req = new NextRequest("http://localhost/api/admin/import-feishu", {
    method: "POST",
    body: JSON.stringify({ wikiUrl: "https://example.feishu.cn/wiki/whatever", name: "越权导入" }),
    headers: { "content-type": "application/json" },
  });
  if (session) {
    req.cookies.set(SESSION_COOKIE, createSession({
      userId: session.userId, name: "测试", avatarUrl: null, isAdmin: session.isAdmin,
    }));
  }
  return req;
}

describe("POST /api/admin/import-feishu 鉴权", () => {
  it("未登录 → 401（修前：直接开始导入）", async () => {
    const res = await POST(makeReq(null));
    expect(res.status).toBe(401);
  });

  it("已登录但非 admin → 403（修前：直接开始导入）", async () => {
    const res = await POST(makeReq({ userId: TEST_USER, isAdmin: false }));
    expect(res.status).toBe(403);
  });
});

// ── 棘轮：admin 路由必须自己查 session + isAdmin ──────────────────────────────

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

function adminRouteFiles(): { path: string; text: string }[] {
  const root = join(process.cwd(), "app", "api", "admin");
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name === "route.ts") out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out;
}

describe("棘轮：app/api/admin 下的写方法必须鉴权", () => {
  it("每条 admin 路由的写 handler 都查 session 与 isAdmin", () => {
    const offenders: string[] = [];
    for (const { path, text } of adminRouteFiles()) {
      for (const method of WRITE_METHODS) {
        const start = text.indexOf(`export async function ${method}(`);
        if (start < 0) continue;
        const rest = text.slice(start);
        const next = rest.indexOf("export async function", "export async function".length);
        const body = next > 0 ? rest.slice(0, next) : rest;
        const rel = path.replace(process.cwd() + "/", "");
        if (!body.includes("getSession(")) offenders.push(`${rel} ${method}: 未取 session`);
        else if (!body.includes("isAdmin")) offenders.push(`${rel} ${method}: 未查 isAdmin`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
