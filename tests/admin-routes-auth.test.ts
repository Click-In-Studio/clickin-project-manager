/**
 * app/api/admin/** 写方法鉴权棘轮。
 *
 * 事故（2026-08-18）：同目录另三条 admin 路由都查 session + isAdmin，只有 import-feishu
 * 一条**完全不鉴权**——仓库里没有 middleware.ts 兜底，于是任何人都能 POST 进来建一个演出
 * 并把任意飞书 bitable 导进库；建出来的演出还不带 owner（createProduction 当时 owner 可选），
 * 正是线上无主演出的来源。
 *
 * import-feishu 本身已整条退役（建项目走 POST /api/productions），针对它的两条鉴权用例
 * 随之删除；棘轮留下——它管的是 app/api/admin/ 下**每一条**路由，不是那一条。
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

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
