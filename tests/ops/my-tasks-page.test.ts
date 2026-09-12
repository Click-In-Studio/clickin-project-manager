// #415（PR #471）：我的任务页改 server 取数后，auth 门从 API 路由移进了 page 本身。
// 此前这页没有 session 门——未登录拿 401 被客户端 .catch 静默吞成「暂无任务」，
// 这个缺口正是因为零测试才存活至今。这里钉住两条语义：
//   1) 无 session → redirect("/login")
//   2) 有 session → server 端取数直接播种给客户端组件（不再存在可吞错的二次 fetch）
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
  }),
}));

// Next 的 redirect 真实实现是 throw；这里用哨兵错误保持同构，方便断言目的地
vi.mock("next/navigation", () => ({
  redirect: (dest: string) => {
    throw Object.assign(new Error(`redirect:${dest}`), { dest });
  },
}));

import MyTasksPage from "@/app/my/tasks/page";

let userId: string;

beforeAll(async () => {
  const res = await getPool().query<{ id: string }>(
    "INSERT INTO app_user DEFAULT VALUES RETURNING id"
  );
  userId = res.rows[0].id;
});

afterAll(async () => {
  await getPool().query("DELETE FROM app_user WHERE id = $1", [userId]).catch(() => {});
});

describe("我的任务页 auth 门（server 取数）", () => {
  it("无 session → redirect(/login)", async () => {
    cookieJar.clear();
    await expect(MyTasksPage()).rejects.toMatchObject({ dest: "/login" });
  });

  it("有 session → server 端取数播种给客户端组件", async () => {
    cookieJar.set(
      SESSION_COOKIE,
      createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })
    );
    const el = await MyTasksPage();
    // 新用户无任何指派/部门任务：钉住「查询发生在 server、以 props 交付」这条通路
    expect(el.props.initialTasks).toEqual([]);
  });
});
