// 通知侧引用解析器（lib/notify/doc/resolver）：直查库、只做 production 归属校验。
// #670 加 task 类型——任务指派 / 事件描述里引用了文档任务项同步出的任务时，站内信
// 与飞书卡片里显示「标题 · 状态」而不是裸 href。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { createNotifyRefResolver } from "@/lib/notify/doc/resolver";
import { createWiki } from "@/lib/wiki/content";
import { createEventTechReq } from "@/lib/ops/event-db";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

let prodId: string;
let userId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  userId = res.rows[0].id;
});
afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = $1", [userId]).catch(() => {});
});

const params = new URLSearchParams();

describe("createNotifyRefResolver", () => {
  it("task → 标题 · 状态 + 任务页 URL；跨剧组 → null", async () => {
    const task = await createEventTechReq({
      id: `tr_${shortId()}`, productionId: prodId, eventId: null, scheduleItemIds: [],
      title: "装台", description: "", presetMinutes: null, departmentId: null, groupId: null,
      assignees: [], createdBy: userId,
    });
    const resolve = createNotifyRefResolver(prodId);
    expect(await resolve({ type: "task", id: task.id, params })).toEqual({
      label: "装台 · 待处理", url: `/production/${prodId}/tasks/${task.id}`,
    });
    const other = await makeProduction();
    try {
      expect(await createNotifyRefResolver(other.prodId)({ type: "task", id: task.id, params })).toBeNull();
    } finally {
      await cleanupProduction(other.prodId).catch(() => {});
    }
    expect(await resolve({ type: "task", id: "tr_nope", params })).toBeNull();
  });

  it("wiki 仍按标题解析（回归）", async () => {
    const doc = await createWiki({ productionId: prodId, title: "排期", createdBy: userId });
    const r = await createNotifyRefResolver(prodId)({ type: "wiki", id: doc.id, params });
    expect(r?.label).toBe("排期");
  });
});
