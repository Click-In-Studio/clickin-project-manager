/**
 * 策略配置中心基建（#236）——词汇表 / 读写 / 写点助手 / 路由门 / 棘轮。
 *
 * 设计见 MindWeave《权限系统-不变量与策略汇总》§2.0（三形状 + 铁律）/ §5（键表）。
 * 本文件只测**基建**：键落全量、白名单校验、审计留痕、形状 A 的集合运算语义。
 * 各写点/判定端接上开关是后续批次，那时各自补自己的测试。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  POLICY_KEYS, ACTION_ROLES, POLICY_ON, POLICY_OFF, policyDef, configurableRows,
} from "@/lib/policy-keys";
import {
  ensureProductionPolicies, getPolicyMap, getPolicyValue, isPolicyOn,
  setPolicies, listPolicies, listPolicyAudit, policyFilteredRows,
} from "@/lib/policy-db";
import { GET as getPolicies, PUT as putPolicies } from "@/app/api/production/[id]/policies/route";

let prodId: string;
let ownerId: string;
let editorId: string;   // 持 production/*/config@edit
let plainId: string;    // 本项目成员，无治理面权限

async function makeUser(tag: string): Promise<string> {
  return (await upsertFeishuUser(`test-open-${shortId()}`, `${tag}-${shortId()}`, null, false)).userId;
}

function makeReq(userId: string | null, body?: unknown, query = ""): NextRequest {
  const req = new NextRequest(`http://localhost/api/production/x/policies${query}`, {
    method: body ? "PUT" : "GET",
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  if (userId) {
    req.cookies.set(SESSION_COOKIE, createSession({
      userId, name: "测试", avatarUrl: null, isAdmin: false,
    }));
  }
  return req;
}

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

beforeAll(async () => {
  ownerId = await makeUser("policy-owner");
  editorId = await makeUser("policy-editor");
  plainId = await makeUser("policy-plain");
  ({ prodId } = await makeProduction(ownerId));
  for (const u of [editorId, plainId]) await addProductionMember(prodId, u);
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'production', '*', 'config', 'edit', 'direct', $2)
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false DO NOTHING`,
    [prodId, editorId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

// ── ① 词汇表自洽（纯常量，不碰库）─────────────────────────────────────────────

describe("词汇表", () => {
  it("键唯一", () => {
    const keys = POLICY_KEYS.map((d) => d.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("每个键的默认值都在自己的合法取值里", () => {
    const bad = POLICY_KEYS.filter((d) => !d.values.includes(d.defaultValue)).map((d) => d.key);
    expect(bad).toEqual([]);
  });

  it("形状 A 的受益方只能是动作角色——不许 role name / dept id（§2.0 推论二）", () => {
    const bad = POLICY_KEYS.filter((d) => d.a && !ACTION_ROLES.includes(d.a.actor)).map((d) => d.key);
    expect(bad).toEqual([]);
  });

  it("形状 A 的动词落在四动词闭集内（M-1）", () => {
    const verbs = new Set(["view", "create", "edit", "delete"]);
    const bad = POLICY_KEYS.filter((d) => d.a && !verbs.has(d.a.row.verb)).map((d) => d.key);
    expect(bad).toEqual([]);
  });

  it("形状 A 的键名可反解回 (type, actor, sub, verb)", () => {
    for (const d of POLICY_KEYS) {
      if (!d.a) continue;
      expect(d.key).toBe(`${d.a.type}.${d.a.actor}:${d.a.row.sub}@${d.a.row.verb}`);
    }
  });

  it("形状 C / L 的键名统一 policy. 前缀，且与形状 A 不混", () => {
    for (const d of POLICY_KEYS) {
      if (d.shape === "A") expect(d.key.startsWith("policy.")).toBe(false);
      else expect(d.key.startsWith("policy.")).toBe(true);
    }
  });

  it("每个键都有非空的人话标题与后果说明", () => {
    const bad = POLICY_KEYS.filter((d) => !d.label.trim() || !d.help.trim()).map((d) => d.key);
    expect(bad).toEqual([]);
  });

  it("默认值规律：破坏性与对外发布默认关（§2.0 推论三）", () => {
    expect(policyDef("event.creator:publication@create")!.defaultValue).toBe(POLICY_OFF);
    expect(policyDef("event.creator:*@delete")!.defaultValue).toBe(POLICY_OFF);
    expect(policyDef("report.creator:*@delete")!.defaultValue).toBe(POLICY_OFF);
    expect(policyDef("task.dept_poc:*@delete")!.defaultValue).toBe(POLICY_OFF);
    expect(policyDef("policy.share_token_enabled")!.defaultValue).toBe(POLICY_OFF);
    // 对内建设性动作默认开
    expect(policyDef("event.creator:call_sheet@edit")!.defaultValue).toBe(POLICY_ON);
    expect(policyDef("event.participant:meta@view")!.defaultValue).toBe(POLICY_ON);
  });

  it("不可配项不在表里：M-14 底座 / 四保留段的 imports / 六步链", () => {
    const keys = new Set(POLICY_KEYS.map((d) => d.key));
    // 内容自持（底座）不得出现
    expect(keys.has("event.creator:meta@view")).toBe(false);
    expect(keys.has("event.creator:details@view")).toBe(false);
    expect(keys.has("event.creator:*@edit")).toBe(false);
    // wiki / asset 无外部归属 ⇒ grants@edit 由 M-14 强制保留，不可配
    expect(keys.has("wiki.creator:grants@edit")).toBe(false);
    expect(keys.has("asset.uploader:grants@edit")).toBe(false);
  });
});

// ── ② 落全量 + 读 ────────────────────────────────────────────────────────────

describe("落全量与读取", () => {
  it("建演出即物化全部键（createProduction 已接 ensure）", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM production_policy WHERE production_id = $1`, [prodId],
    );
    expect(Number(rows[0].n)).toBe(POLICY_KEYS.length);
  });

  it("物化的值等于词汇表默认值", async () => {
    const map = await getPolicyMap(prodId);
    for (const d of POLICY_KEYS) expect(map.get(d.key)).toBe(d.defaultValue);
  });

  it("ensure 幂等，且**不覆盖**已改过的值（物化即冻结）", async () => {
    await setPolicies(prodId, { "event.creator:call_sheet@edit": POLICY_OFF }, editorId);
    await ensureProductionPolicies(prodId);
    await ensureProductionPolicies(prodId);
    expect(await getPolicyValue(prodId, "event.creator:call_sheet@edit")).toBe(POLICY_OFF);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM production_policy WHERE production_id = $1`, [prodId],
    );
    expect(Number(rows[0].n)).toBe(POLICY_KEYS.length);
    await setPolicies(prodId, { "event.creator:call_sheet@edit": POLICY_ON }, editorId);
  });

  it("isPolicyOn 便捷读法", async () => {
    expect(await isPolicyOn(prodId, "event.creator:call_sheet@edit")).toBe(true);
    expect(await isPolicyOn(prodId, "policy.share_token_enabled")).toBe(false);
  });
});

// ── ③ 写：白名单 + 审计 ──────────────────────────────────────────────────────

describe("写入校验与审计", () => {
  it("未知键 → 拒绝，且一行都不落", async () => {
    const before = await getPolicyMap(prodId);
    const res = await setPolicies(prodId, {
      "event.creator:call_sheet@edit": POLICY_OFF,
      "policy.nonexistent_key": POLICY_ON,
    }, editorId);
    expect(res.ok).toBe(false);
    // 整体校验先行：合法的那条也不该生效
    expect((await getPolicyMap(prodId)).get("event.creator:call_sheet@edit"))
      .toBe(before.get("event.creator:call_sheet@edit"));
  });

  it("非法取值 → 拒绝（多档键只认白名单）", async () => {
    const res = await setPolicies(prodId, { "policy.orphan_task_disposition": "nuke" }, editorId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("orphan_task_disposition");
  });

  it("改动写审计：who / 旧值 → 新值", async () => {
    await setPolicies(prodId, { "policy.share_token_enabled": POLICY_ON }, editorId);
    const audit = await listPolicyAudit(prodId);
    const hit = audit.find((a) => a.policyKey === "policy.share_token_enabled");
    expect(hit).toBeDefined();
    expect(hit!.oldValue).toBe(POLICY_OFF);
    expect(hit!.newValue).toBe(POLICY_ON);
    expect(hit!.changedBy).toBe(editorId);
    await setPolicies(prodId, { "policy.share_token_enabled": POLICY_OFF }, editorId);
  });

  it("值没变 → 不写审计（不制造噪声）", async () => {
    const before = (await listPolicyAudit(prodId)).length;
    const res = await setPolicies(prodId, { "policy.wiki_public_enabled": POLICY_ON }, editorId);
    expect(res.ok && res.changed).toEqual([]);
    expect((await listPolicyAudit(prodId)).length).toBe(before);
  });
});

// ── ④ 形状 A 的写点助手：集合运算，两个方向都要走 ────────────────────────────

describe("policyFilteredRows", () => {
  const EVENT_MANAGE: ReadonlyArray<readonly [string, string]> = [
    ["meta", "view"], ["details", "view"], ["publication", "view"], ["*", "edit"],
    ["assignees", "create"], ["assignees", "delete"], ["call_sheet", "edit"],
    ["tasks", "create"], ["tasks", "delete"],
    ["reports", "create"], ["reports", "delete"],
    ["publication", "edit"], ["publication", "delete"],
    ["grants", "edit"],
  ];
  const ids = (rows: Array<readonly [string, string]>) => rows.map(([s, v]) => `${s}@${v}`).sort();

  it("全默认时行集与今天一致（基建上线不改变任何现有行为）", async () => {
    const out = await policyFilteredRows(prodId, "event", "creator", EVENT_MANAGE);
    expect(ids(out)).toEqual(ids([...EVENT_MANAGE]));
  });

  it("关掉默认开的可配行 ⇒ 从行集里去掉", async () => {
    await setPolicies(prodId, { "event.creator:call_sheet@edit": POLICY_OFF }, editorId);
    const out = await policyFilteredRows(prodId, "event", "creator", EVENT_MANAGE);
    expect(ids(out)).not.toContain("call_sheet@edit");
    await setPolicies(prodId, { "event.creator:call_sheet@edit": POLICY_ON }, editorId);
  });

  it("打开默认关的可配行 ⇒ **加进**行集（不在原行集里也要加）", async () => {
    expect(ids([...EVENT_MANAGE])).not.toContain("publication@create");
    await setPolicies(prodId, { "event.creator:publication@create": POLICY_ON }, editorId);
    const out = await policyFilteredRows(prodId, "event", "creator", EVENT_MANAGE);
    expect(ids(out)).toContain("publication@create");
    await setPolicies(prodId, { "event.creator:publication@create": POLICY_OFF }, editorId);
  });

  it("M-14 底座不受任何开关影响（不在词汇表里 ⇒ 原样保留）", async () => {
    await setPolicies(prodId, {
      "event.creator:call_sheet@edit": POLICY_OFF,
      "event.creator:grants@edit": POLICY_OFF,
      "event.creator:assignees@create": POLICY_OFF,
    }, editorId);
    const out = await policyFilteredRows(prodId, "event", "creator", EVENT_MANAGE);
    for (const base of ["meta@view", "details@view", "publication@view", "*@edit"]) {
      expect(ids(out)).toContain(base);
    }
    await setPolicies(prodId, {
      "event.creator:call_sheet@edit": POLICY_ON,
      "event.creator:grants@edit": POLICY_ON,
      "event.creator:assignees@create": POLICY_ON,
    }, editorId);
  });

  it("无可配键的 (type, actor) 原样返回", async () => {
    expect(configurableRows("scene", "creator")).toEqual([]);
    const out = await policyFilteredRows(prodId, "scene", "creator", [["meta", "view"]]);
    expect(ids(out)).toEqual(["meta@view"]);
  });
});

// ── ⑤ 路由门 ────────────────────────────────────────────────────────────────

describe("GET / PUT /api/production/[id]/policies", () => {
  it("未登录 → 401", async () => {
    expect((await getPolicies(makeReq(null), ctx())).status).toBe(401);
  });

  it("成员但无治理面权限 → 403（读写都拦）", async () => {
    expect((await getPolicies(makeReq(plainId), ctx())).status).toBe(403);
    const res = await putPolicies(makeReq(plainId, { changes: {} }), ctx());
    expect(res.status).toBe(403);
  });

  it("持 config@edit → GET 返回全部键 + 元信息", async () => {
    const res = await getPolicies(makeReq(editorId), ctx());
    expect(res.status).toBe(200);
    const body = await res.json() as { policies: { key: string; value: string; isDefault: boolean }[] };
    expect(body.policies.length).toBe(POLICY_KEYS.length);
    expect(body.policies.every((p) => p.value.length > 0)).toBe(true);
  });

  it("?audit=1 附带改动记录", async () => {
    const res = await getPolicies(makeReq(editorId, undefined, "?audit=1"), ctx());
    const body = await res.json() as { audit?: unknown[] };
    expect(Array.isArray(body.audit)).toBe(true);
  });

  it("PUT 非法 body → 400", async () => {
    expect((await putPolicies(makeReq(editorId, {}), ctx())).status).toBe(400);
    expect((await putPolicies(makeReq(editorId, { changes: { "policy.share_token_enabled": 1 } }), ctx())).status).toBe(400);
  });

  it("PUT 合法 → 200 并回报实际变更", async () => {
    const res = await putPolicies(
      makeReq(editorId, { changes: { "policy.task_dept_visibility": POLICY_OFF } }), ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { changed: { key: string; from: string; to: string }[] };
    expect(body.changed).toEqual([
      { key: "policy.task_dept_visibility", from: POLICY_ON, to: POLICY_OFF },
    ]);
    await setPolicies(prodId, { "policy.task_dept_visibility": POLICY_ON }, editorId);
  });

  it("listPolicies 标出哪些已偏离默认", async () => {
    await setPolicies(prodId, { "policy.note_create_requires_poc": POLICY_ON }, editorId);
    const list = await listPolicies(prodId);
    const hit = list.find((p) => p.key === "policy.note_create_requires_poc")!;
    expect(hit.isDefault).toBe(false);
    expect(list.filter((p) => !p.isDefault).map((p) => p.key)).toEqual(["policy.note_create_requires_poc"]);
    await setPolicies(prodId, { "policy.note_create_requires_poc": POLICY_OFF }, editorId);
  });
});

// ── ⑥ 棘轮：幽灵键 ──────────────────────────────────────────────────────────

describe("棘轮：production_policy 不得出现词汇表以外的键", () => {
  it("全库扫描（对标 permission-migration-ledger 的退役键棘轮）", async () => {
    const { rows } = await getPool().query<{ policy_key: string }>(
      `SELECT DISTINCT policy_key FROM production_policy`,
    );
    const known = new Set(POLICY_KEYS.map((d) => d.key));
    expect(rows.map((r) => r.policy_key).filter((k) => !known.has(k))).toEqual([]);
  });
});

// ── ⑦ R 系写点端到端：开关真的作用到了定式上 ──────────────────────────────────

describe("R 系定式接开关（端到端）", () => {
  it("R-1 参与者行集：关掉 event.participant:details@view ⇒ 只发 meta@view", async () => {
    const { createProductionEvent, setEventParticipants } = await import("@/lib/event-db");
    const { hasGrant } = await import("@/lib/grant-check");
    const guest = await makeUser("r1-guest");
    await addProductionMember(prodId, guest);
    await setPolicies(prodId, { "event.participant:details@view": POLICY_OFF }, editorId);

    const ev = await createProductionEvent({
      id: `ev_${shortId()}`, productionId: prodId, title: "R1", eventType: "rehearsal",
      location: "", startTime: null, endTime: null, description: "", createdBy: ownerId,
    });
    await setEventParticipants(
      ev.id, [{ userId: guest, name: "客", departmentId: null, role: "participant" }],
      prodId, ownerId,
    );
    expect(await hasGrant(guest, prodId, "event", ev.id, "meta", "view")).toBe(true);
    expect(await hasGrant(guest, prodId, "event", ev.id, "details", "view")).toBe(false);

    await setPolicies(prodId, { "event.participant:details@view": POLICY_ON }, editorId);
    await getPool().query("DELETE FROM production_event WHERE id = $1", [ev.id]);
  });

  it("R-6 POC notes 三行：关掉 delete ⇒ 上任只发 create/edit，但卸任撤销不受影响", async () => {
    const { createProductionDept, setDeptMembers } = await import("@/lib/dept-db");
    const { hasGrant } = await import("@/lib/grant-check");
    const poc = await makeUser("r6-poc");
    await addProductionMember(prodId, poc);
    const dept = await createProductionDept({ productionId: prodId, name: `R6部门${shortId()}` });
    await setPolicies(prodId, { "dept.poc:notes@delete": POLICY_OFF }, editorId);

    await setDeptMembers(dept.id, prodId, [{ userId: poc, isPoc: true }]);
    expect(await hasGrant(poc, prodId, "dept", dept.id, "notes", "create")).toBe(true);
    expect(await hasGrant(poc, prodId, "dept", dept.id, "notes", "delete")).toBe(false);

    // 卸任照撤——开关只裁上任发行那一侧，不该让「唯一收行定式」失效
    await setDeptMembers(dept.id, prodId, []);
    expect(await hasGrant(poc, prodId, "dept", dept.id, "notes", "create")).toBe(false);

    await setPolicies(prodId, { "dept.poc:notes@delete": POLICY_ON }, editorId);
  });
});
