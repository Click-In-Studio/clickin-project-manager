/**
 * 财务的语义锁。
 *
 *   1. 不是 sensitive 域——审批走完整阶梯，不是直达 owner
 *   2. 审批人由 buildApprovalLadder 算，与权限申请同一个函数（不自己挑人）
 *   3. 科目的归属部门 → resource_dept_manage → 该部门 POC 自动成为审批人
 *   4. 当前级不能终局时 approve 是**转发**，不是通过
 *   5. first-action-wins：已处理的支出不能被再处理
 *   6. 撤回只有提交人自己
 *   7. 金额用 NUMERIC，过 API 不丢精度
 *   8. 删科目不连坐删支出（已发生的钱不因整理科目表而消失）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { classifyApprovalNode, buildApprovalLadder } from "@/lib/approval-routing";
import {
  approveExpense, cancelExpense, createBudgetCategory, deleteBudgetCategory,
  escalateExpiredExpenses, FinanceError, getExpense, listBudgetCategories, listExpenses,
  listPendingExpenses, rejectExpense, submitExpense, updateBudgetCategory,
} from "@/lib/finance-db";

let prodId: string;
let ownerId: string, submitterId: string, deptPocId: string, strangerId: string;
let deptId: string;

beforeAll(async () => {
  ownerId     = (await upsertFeishuUser(`test-open-${shortId()}`, `财务owner${shortId()}`, null, false)).userId;
  submitterId = (await upsertFeishuUser(`test-open-${shortId()}`, `报销人${shortId()}`, null, false)).userId;
  deptPocId   = (await upsertFeishuUser(`test-open-${shortId()}`, `舞美POC${shortId()}`, null, false)).userId;
  strangerId  = (await upsertFeishuUser(`test-open-${shortId()}`, `财务路人${shortId()}`, null, false)).userId;

  ({ prodId } = await makeProduction(ownerId));
  for (const u of [submitterId, deptPocId, strangerId]) await addProductionMember(prodId, u);

  ({ rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
    [prodId, `舞美${shortId()}`],
  ));
  await getPool().query(
    `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,true)`,
    [prodId, deptId, deptPocId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

async function makeCategory(name: string, amount = "280000.00", withDept = true) {
  return createBudgetCategory({
    productionId: prodId, name: `${name}${shortId()}`, amount,
    deptId: withDept ? deptId : null, createdBy: ownerId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("1. 财务不是 sensitive 域", () => {
  it("classifyApprovalNode 判成 normal —— 决定了走完整阶梯而非直达 owner", () => {
    expect(classifyApprovalNode("finance", "expenses", "edit")).toBe("normal");
    expect(classifyApprovalNode("finance", "budget", "view")).toBe("normal");
    // 对照：production 的敏感面确实是 sensitive
    expect(classifyApprovalNode("production", "integrations", "view")).toBe("sensitive");
  });
});

describe("2 & 3. 审批人由阶梯算出，科目归属部门自动成为一级", () => {
  it("提交后当前审批人里含该科目归属部门的 POC", async () => {
    const cat = await makeCategory("舞美制作");
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "舞台模型材料",
      amount: "8600.00", submittedBy: submitterId,
    });
    expect(e.status).toBe("pending");

    // 阶梯是同一个函数算的——这里直接比对，确保没有第二套路由
    const ladder = await buildApprovalLadder({
      productionId: prodId, subjectId: submitterId,
      resourceType: "finance", resourceId: cat.id, resourceSub: "expenses",
      permissionLevel: "edit",
    });
    expect(e.currentStage).toBe(ladder[0].stage);
    expect(e.currentApproverIds.sort()).toEqual(ladder[0].approverIds.sort());

    // 归属部门的 POC 一定在某一级里（resource_dept_manage 那行是建科目时写的）
    expect(ladder.some(s => s.approverIds.includes(deptPocId))).toBe(true);
  });

  it("科目改归属部门，路由跟着变", async () => {
    const cat = await makeCategory("先无部门", "1000.00", false);
    const { rows: [{ id: otherDept }] } = await getPool().query<{ id: string }>(
      `INSERT INTO production_dept (production_id, name) VALUES ($1, $2) RETURNING id`,
      [prodId, `灯光${shortId()}`],
    );
    const otherPoc = (await upsertFeishuUser(`test-open-${shortId()}`, `灯光POC${shortId()}`, null, false)).userId;
    await addProductionMember(prodId, otherPoc);
    await getPool().query(
      `INSERT INTO production_dept_member (production_id, dept_id, user_id, is_poc) VALUES ($1,$2,$3,true)`,
      [prodId, otherDept, otherPoc],
    );

    await updateBudgetCategory(cat.id, prodId, ownerId, { deptId: otherDept });
    const ladder = await buildApprovalLadder({
      productionId: prodId, subjectId: submitterId,
      resourceType: "finance", resourceId: cat.id, resourceSub: "expenses",
      permissionLevel: "edit",
    });
    expect(ladder.some(s => s.approverIds.includes(otherPoc))).toBe(true);
  });

  it("待办只给当前级的审批人看得到", async () => {
    const cat = await makeCategory("待办口径");
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "待办用",
      amount: "100.00", submittedBy: submitterId,
    });
    const approverId = e.currentApproverIds[0];
    expect((await listPendingExpenses(approverId, prodId)).some(x => x.id === e.id)).toBe(true);
    expect((await listPendingExpenses(strangerId, prodId)).some(x => x.id === e.id)).toBe(false);
    // 提交人自己也不在待办里（阶梯会去掉本人）
    expect((await listPendingExpenses(submitterId, prodId)).some(x => x.id === e.id)).toBe(false);
  });
});

describe("4. 当前级不能终局时是转发", () => {
  it("canFinalize=false 的级 approve 之后仍是 pending，只是换了一级", async () => {
    const cat = await makeCategory("转发场");
    // 给报销人安一个上级——上级没有财务权，所以 canFinalize=false
    await getPool().query(
      `UPDATE production_member SET supervisor_id = $3
        WHERE production_id = $1 AND user_id = $2`,
      [prodId, submitterId, strangerId],
    );
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "转发用",
      amount: "50.00", submittedBy: submitterId,
    });
    expect(e.currentStage).toBe("supervisor");
    expect(e.canFinalize).toBe(false);

    const res = await approveExpense(e.id, prodId, strangerId);
    expect(res).toEqual({ ok: true, forwarded: true });

    const after = (await getExpense(e.id, prodId))!;
    expect(after.status).toBe("pending");          // 没通过，只是往上递了
    expect(after.currentStage).not.toBe("supervisor");
    expect(after.currentApproverIds).not.toContain(strangerId);

    await getPool().query(
      `UPDATE production_member SET supervisor_id = NULL WHERE production_id = $1 AND user_id = $2`,
      [prodId, submitterId],
    );
  });
});

describe("5. first-action-wins", () => {
  it("已批准的支出不能再被批准或拒绝", async () => {
    const cat = await makeCategory("一次性");
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "只处理一次",
      amount: "200.00", submittedBy: submitterId,
    });
    const approverId = e.currentApproverIds[0];
    expect((await approveExpense(e.id, prodId, approverId)).ok).toBe(true);
    expect((await getExpense(e.id, prodId))!.status).toBe("approved");

    expect(await approveExpense(e.id, prodId, approverId)).toEqual({ ok: false, reason: "not_pending" });
    expect((await rejectExpense(e.id, prodId, approverId)).ok).toBe(false);
  });
});

describe("6. 撤回只有提交人自己", () => {
  it("别人撤不动；自己可以；已处理的撤不动", async () => {
    const cat = await makeCategory("撤回场");
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "要撤的",
      amount: "300.00", submittedBy: submitterId,
    });
    expect((await cancelExpense(e.id, prodId, ownerId)).ok).toBe(false);
    expect((await cancelExpense(e.id, prodId, submitterId)).ok).toBe(true);
    expect((await getExpense(e.id, prodId))!.status).toBe("cancelled");
    expect((await cancelExpense(e.id, prodId, submitterId)).ok).toBe(false);
  });
});

describe("7. 金额不丢精度", () => {
  it("NUMERIC 全程走字符串，两位小数原样进出", async () => {
    const cat = await makeCategory("精度", "999999999999.99");
    expect(cat.amount).toBe("999999999999.99");

    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "分币",
      amount: "0.07", submittedBy: submitterId,
    });
    expect(e.amount).toBe("0.07");

    // 已批准的支出计入科目的 spent
    await approveExpense(e.id, prodId, e.currentApproverIds[0]);
    const after = (await listBudgetCategories(prodId)).find(c => c.id === cat.id)!;
    expect(after.spent).toBe("0.07");
  });

  it("未批准的支出不计入 spent", async () => {
    const cat = await makeCategory("只算已批");
    await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "还没批",
      amount: "500.00", submittedBy: submitterId,
    });
    const after = (await listBudgetCategories(prodId)).find(c => c.id === cat.id)!;
    expect(Number(after.spent)).toBe(0);
  });
});

describe("8. 删科目不连坐删支出", () => {
  it("科目没了，支出还在，只是没归科目", async () => {
    const cat = await makeCategory("将被删");
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "已发生的钱",
      amount: "1200.00", submittedBy: submitterId,
    });
    await deleteBudgetCategory(cat.id, prodId);

    const after = await getExpense(e.id, prodId);
    expect(after).not.toBeNull();
    expect(after!.categoryId).toBeNull();
    expect(after!.amount).toBe("1200.00");
  });
});

describe("9. 超时升级", () => {
  /** 把链末条的 notifiedAt 往前推，模拟"当前级放着没动 N 小时"。 */
  async function ageExpense(expenseId: string, hours: number) {
    await getPool().query(
      `UPDATE production_expense
          SET escalation_chain = jsonb_set(
                escalation_chain,
                ARRAY[(jsonb_array_length(escalation_chain) - 1)::text, 'notifiedAt'],
                to_jsonb((now() - ($2 || ' hours')::interval)::text))
        WHERE id = $1`,
      [expenseId, String(hours)],
    );
  }

  it("**缺 production_approval_config 行时照样升级**（权限申请那边静默死过的坑）", async () => {
    // 模拟「早于 production_approval_config 这张表的存量演出」——它们一行配置都没有。
    // 权限申请那边就是这么静默死的：INNER JOIN 让这些演出永远匹配不上，
    // 线上 8 个演出的整条升级链自 Phase 7 起是死的。缺行必须按列默认值 24h 计时。
    await getPool().query(
      "DELETE FROM production_approval_config WHERE production_id = $1", [prodId],
    );
    const { rows } = await getPool().query(
      "SELECT 1 FROM production_approval_config WHERE production_id = $1", [prodId],
    );
    expect(rows).toHaveLength(0);

    const cat = await makeCategory("超时升级");
    await getPool().query(
      `UPDATE production_member SET supervisor_id = $3 WHERE production_id = $1 AND user_id = $2`,
      [prodId, submitterId, strangerId],
    );
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "放着没人管",
      amount: "77.00", submittedBy: submitterId,
    });
    expect(e.currentStage).toBe("supervisor");

    await ageExpense(e.id, 48);          // 超过默认 24h
    const res = await escalateExpiredExpenses();
    expect(res.escalated).toBeGreaterThan(0);

    const after = (await getExpense(e.id, prodId))!;
    expect(after.status).toBe("pending");
    expect(after.currentStage).not.toBe("supervisor");   // 已经升到下一级
    expect(after.currentApproverIds).not.toContain(strangerId);

    await getPool().query(
      `UPDATE production_member SET supervisor_id = NULL WHERE production_id = $1 AND user_id = $2`,
      [prodId, submitterId],
    );
  });

  it("没超时的不动", async () => {
    const cat = await makeCategory("刚提交");
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "才提交",
      amount: "5.00", submittedBy: submitterId,
    });
    const before = (await getExpense(e.id, prodId))!.currentStage;
    await escalateExpiredExpenses();
    expect((await getExpense(e.id, prodId))!.currentStage).toBe(before);
  });

  it("计时起点是当前级被通知的时刻，不是提交时刻——多级不会一个 TTL 里跳完", async () => {
    const cat = await makeCategory("逐级计时");
    const e = await submitExpense({
      productionId: prodId, categoryId: cat.id, title: "逐级",
      amount: "9.00", submittedBy: submitterId,
    });
    await ageExpense(e.id, 48);
    await escalateExpiredExpenses();
    const once = (await getExpense(e.id, prodId))!;

    // 再跑一次：新一级的 notifiedAt 是刚写的，不该再跳
    await escalateExpiredExpenses();
    expect((await getExpense(e.id, prodId))!.currentStage).toBe(once.currentStage);
  });
});

describe("同名科目与列表口径", () => {
  it("同项目内科目名唯一", async () => {
    const name = `唯一${shortId()}`;
    await createBudgetCategory({ productionId: prodId, name, amount: "1.00", createdBy: ownerId });
    await expect(createBudgetCategory({
      productionId: prodId, name, amount: "2.00", createdBy: ownerId,
    })).rejects.toThrow(FinanceError);
  });

  it("支出列表只列本项目的", async () => {
    const { prodId: other } = await makeProduction(ownerId);
    expect((await listExpenses(other)).length).toBe(0);
    expect((await listExpenses(prodId)).length).toBeGreaterThan(0);
    await cleanupProduction(other).catch(() => {});
  });
});
