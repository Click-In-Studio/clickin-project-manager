// task 引用解析（#670）：`[#](/__cm__/task/<id>)` 的标签 = 标题 · 状态，URL 指任务详情页；
// 已删除 → 「#[已删除]」；跨剧组不解析；无剧本权限的成员也能解析（标题级信息，§4.1）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { POST as mentionResolvePOST } from "@/app/api/production/[id]/mention-resolve/route";
import { createEventTechReq, deleteTaskByProduction } from "@/lib/ops/event-db";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";

let prodId: string;
let member: string;
const users: string[] = [];

async function newMember(pid: string): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const uid = res.rows[0].id;
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`, [pid, uid]);
  users.push(uid);
  return uid;
}

async function newTask(pid: string, title: string): Promise<string> {
  const req = await createEventTechReq({
    id: `tr_${shortId()}`, productionId: pid, eventId: null, scheduleItemIds: [],
    title, description: "", presetMinutes: null, departmentId: null, groupId: null,
    assignees: [], createdBy: member,
  });
  return req.id;
}

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });
function resolveReq(ids: string[], userId = member) {
  return new NextRequest("http://localhost/api/production/x/mention-resolve", {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mentions: ids.map(id => ({ kind: "task", displayMode: null, id, aux: null, versionId: null })),
    }),
  });
}
async function resolve(ids: string[]): Promise<{ labels: (string | null)[]; urls: (string | null)[] }> {
  const res = await mentionResolvePOST(resolveReq(ids), ctx());
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  member = await newMember(prodId);
});
afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("mention-resolve kind=task", () => {
  it("标签 = 标题 · 状态，URL = 任务详情页；成员无剧本权限也能解析", async () => {
    const taskId = await newTask(prodId, "装台");
    const { labels, urls } = await resolve([taskId]);
    expect(labels[0]).toBe("装台 · 待处理");
    expect(urls[0]).toBe(`/production/${prodId}/tasks/${taskId}`);
  });

  it("状态推进后标签跟着变（chip 不冻旧状态）", async () => {
    const taskId = await newTask(prodId, "对光");
    await getPool().query("UPDATE task SET status = 'in_progress' WHERE id = $1", [taskId]);
    expect((await resolve([taskId])).labels[0]).toBe("对光 · 进行中");
  });

  it("任务删除 → #[已删除]（既有死引用降级）", async () => {
    const taskId = await newTask(prodId, "将被删");
    await deleteTaskByProduction(taskId, prodId);
    const { labels, urls } = await resolve([taskId]);
    expect(labels[0]).toBe("#[已删除]");
    expect(urls[0]).toBeNull();
  });

  it("跨剧组的任务 id 不解析（不泄漏别处标题）", async () => {
    const other = await makeProduction();
    try {
      const foreign = await createEventTechReq({
        id: `tr_${shortId()}`, productionId: other.prodId, eventId: null, scheduleItemIds: [],
        title: "别家的活", description: "", presetMinutes: null, departmentId: null, groupId: null,
        assignees: [], createdBy: member,
      });
      const { labels } = await resolve([foreign.id]);
      expect(labels[0]).toBe("#[已删除]");
    } finally {
      await cleanupProduction(other.prodId).catch(() => {});
    }
  });
});
