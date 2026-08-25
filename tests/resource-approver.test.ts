/**
 * 资源审批人配置（#262）
 *
 * 验证点：
 *  - 清册：production / producer 不可配（没有第二个归属方），人事域 member 可配
 *  - 写入门：不可委派类型、未登记类型、跨演出部门、非本演出成员一律拒收
 *  - 路由命中：配了就进 buildApprovalLadder 的 dept_poc 级；**未配时阶梯与今天
 *    完全一致**（这条是回归钉——本 PR 不改路由，路由要是变了它先红）
 *  - 覆盖式保存只换类型级行（'*'/'*'），不碰建事件/建任务写的实例行
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { addProductionMember } from "@/lib/db";
import { createProductionDept, setDeptMembers, addResourceDeptManage } from "@/lib/dept-db";
import { buildApprovalLadder, findProducers } from "@/lib/approval-routing";
import {
  listDelegableResourceTypes,
  listResourceApprovers,
  setResourceApprovers,
  isDelegableResourceType,
  isConfigurableResourceType,
  ResourceApproverError,
} from "@/lib/resource-approver-db";
import { groupResourceTypes } from "@/lib/permission-labels";
import { makeProduction, cleanupProduction } from "./factories";

const U_OWNER     = "00000000-0000-0000-0002-000000000001";
const U_REQUESTER = "00000000-0000-0000-0002-000000000002";
const U_HR_POC    = "00000000-0000-0000-0002-000000000003";
const U_HR_PERSON = "00000000-0000-0000-0002-000000000004";
const U_OUTSIDER  = "00000000-0000-0000-0002-000000000005";
const ALL_USERS = [U_OWNER, U_REQUESTER, U_HR_POC, U_HR_PERSON, U_OUTSIDER];

let prodId: string;
let otherProdId: string;
let hrDeptId: string;
let foreignDeptId: string;

beforeAll(async () => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_user (id, created_at)
     SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[]) ON CONFLICT DO NOTHING`,
    [ALL_USERS, ALL_USERS.map(() => new Date())],
  );

  ({ prodId } = await makeProduction(U_OWNER));
  ({ prodId: otherProdId } = await makeProduction(U_OWNER));

  for (const userId of [U_REQUESTER, U_HR_POC, U_HR_PERSON]) {
    await addProductionMember(prodId, userId);
  }

  const hr = await createProductionDept({ productionId: prodId, name: "人事组" });
  hrDeptId = hr.id;
  await setDeptMembers(hrDeptId, prodId, [{ userId: U_HR_POC, isPoc: true }]);

  // 另一场演出的部门：FK 只保证部门存在，不保证是**这场**演出的
  const foreign = await createProductionDept({ productionId: otherProdId, name: "别家部门" });
  foreignDeptId = foreign.id;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await cleanupProduction(otherProdId).catch(() => {});
  await getPool()
    .query("DELETE FROM app_user WHERE id = ANY($1)", [ALL_USERS])
    .catch(() => {});
});

/** 人事域的一条真实申请面：member/*&#8203;/roles@edit（角色指派），classify 为 normal。 */
function memberTarget() {
  return {
    productionId: prodId,
    subjectId: U_REQUESTER,
    resourceType: "member",
    resourceId: "*",
    resourceSub: "roles",
    permissionLevel: "edit",
  };
}

async function clearMemberApprovers() {
  await setResourceApprovers({
    productionId: prodId, resourceType: "member",
    deptIds: [], userIds: [], establishedBy: U_OWNER,
  });
}

describe("可配清册", () => {
  it("production / producer 不可委派，人事域 member 可配", async () => {
    expect(isDelegableResourceType("production")).toBe(false);
    expect(isDelegableResourceType("producer")).toBe(false);
    expect(isDelegableResourceType("member")).toBe(true);

    const types = await listDelegableResourceTypes();
    expect(types).not.toContain("production");
    expect(types).not.toContain("producer");
    expect(types).toContain("member");
  });

  it("死类型 tech_req 不进清册（判定侧只读 'task'，配了也永不生效）", async () => {
    expect(await listDelegableResourceTypes()).not.toContain("tech_req");
  });

  it("分组排序不丢类型：没登记进 TYPE_GROUPS 的落「其他」，不会从界面消失", async () => {
    const types = await listDelegableResourceTypes();
    const grouped = groupResourceTypes([...types, "brand_new_type"]);
    const flat = grouped.flatMap((g) => g.types);
    expect(new Set(flat)).toEqual(new Set([...types, "brand_new_type"]));
    expect(flat.length).toBe(types.length + 1);  // 不重复出现在两个组里
    expect(grouped.find((g) => g.label === "其他")?.types).toContain("brand_new_type");
  });

  it("分组顺序按域走，不按类型键字母序", () => {
    const grouped = groupResourceTypes(["member", "scene", "finance", "event"]);
    expect(grouped.map((g) => g.label)).toEqual(["剧本与内容", "排演与执行", "资产与财务", "人与部门"]);
  });
});

describe("写入门", () => {
  it("production / producer 拒收（没有第二个归属方，配了也不会被路由读到）", async () => {
    for (const resourceType of ["production", "producer"]) {
      await expect(
        setResourceApprovers({
          productionId: prodId, resourceType,
          deptIds: [hrDeptId], userIds: [], establishedBy: U_OWNER,
        }),
      ).rejects.toMatchObject({ code: "non_delegable" });
    }
    // 拒收要真的没写进去——否则治理后台会显示一条骗人的配置
    const { rows } = await getPool().query(
      `SELECT 1 FROM resource_dept_manage
       WHERE production_id = $1 AND resource_type IN ('production','producer')`,
      [prodId],
    );
    expect(rows.length).toBe(0);
  });

  it("死类型 tech_req 拒收——清册滤了不算数，API 直接 PUT 也得拦住", async () => {
    // tech_req 在 resource_permission_level 里有行，过得了存在性检查；
    // 拦它的必须是与清册同源的那道门，否则存下来就是一条谁也不读的假配置。
    await expect(
      setResourceApprovers({
        productionId: prodId, resourceType: "tech_req",
        deptIds: [hrDeptId], userIds: [], establishedBy: U_OWNER,
      }),
    ).rejects.toMatchObject({ code: "dead_type" });

    const { rows } = await getPool().query(
      `SELECT 1 FROM resource_dept_manage WHERE production_id = $1 AND resource_type = 'tech_req'`,
      [prodId],
    );
    expect(rows.length).toBe(0);
  });

  it("清册与写入门同源：清册里没有的类型，写入门也不收", async () => {
    const listed = new Set(await listDelegableResourceTypes());
    for (const t of ["production", "producer", "tech_req"]) {
      expect(listed.has(t)).toBe(false);
      expect(isConfigurableResourceType(t)).toBe(false);
    }
    for (const t of listed) expect(isConfigurableResourceType(t)).toBe(true);
  });

  it("未登记的资源类型拒收", async () => {
    await expect(
      setResourceApprovers({
        productionId: prodId, resourceType: "not_a_real_type",
        deptIds: [], userIds: [U_HR_PERSON], establishedBy: U_OWNER,
      }),
    ).rejects.toMatchObject({ code: "unknown_type" });
  });

  it("跨演出的部门拒收", async () => {
    await expect(
      setResourceApprovers({
        productionId: prodId, resourceType: "member",
        deptIds: [foreignDeptId], userIds: [], establishedBy: U_OWNER,
      }),
    ).rejects.toMatchObject({ code: "bad_dept" });
  });

  it("非本演出成员拒收（进了阶梯也点不动，申请会卡到超时）", async () => {
    await expect(
      setResourceApprovers({
        productionId: prodId, resourceType: "member",
        deptIds: [], userIds: [U_OUTSIDER], establishedBy: U_OWNER,
      }),
    ).rejects.toMatchObject({ code: "bad_user" });
  });

  it("抛的是 ResourceApproverError（路由层据此回 400 而非 500）", async () => {
    await expect(
      setResourceApprovers({
        productionId: prodId, resourceType: "producer",
        deptIds: [], userIds: [], establishedBy: U_OWNER,
      }),
    ).rejects.toBeInstanceOf(ResourceApproverError);
  });
});

describe("路由命中", () => {
  it("未配 → 阶梯里没有 dept_poc 级（本 PR 不改路由的回归钉）", async () => {
    await clearMemberApprovers();
    const ladder = await buildApprovalLadder(memberTarget());
    expect(ladder.find((s) => s.stage === "dept_poc")).toBeUndefined();
    // 兜底仍在：制作人这场没有，owner 必然在
    expect(ladder.at(-1)?.stage).toBe("owner");
    expect(ladder.at(-1)?.approverIds).toEqual([U_OWNER]);
  });

  it("配了审批部门 → dept_poc 级出现该部门 POC（不是全体部门成员）", async () => {
    await setResourceApprovers({
      productionId: prodId, resourceType: "member",
      deptIds: [hrDeptId], userIds: [], establishedBy: U_OWNER,
    });
    const stage = (await buildApprovalLadder(memberTarget())).find((s) => s.stage === "dept_poc");
    expect(stage?.approverIds).toEqual([U_HR_POC]);
    expect(stage?.canFinalize).toBe(true);
    await clearMemberApprovers();
  });

  it("配了个人审批人 → 同一级出现该人", async () => {
    await setResourceApprovers({
      productionId: prodId, resourceType: "member",
      deptIds: [], userIds: [U_HR_PERSON], establishedBy: U_OWNER,
    });
    const stage = (await buildApprovalLadder(memberTarget())).find((s) => s.stage === "dept_poc");
    expect(stage?.approverIds).toEqual([U_HR_PERSON]);
    await clearMemberApprovers();
  });

  it("类型级配置对该类型的任意 sub 生效（行是 '*'，路由按通配匹配）", async () => {
    await setResourceApprovers({
      productionId: prodId, resourceType: "member",
      deptIds: [hrDeptId], userIds: [], establishedBy: U_OWNER,
    });
    for (const resourceSub of ["roles", "contact", "*"]) {
      const ladder = await buildApprovalLadder({ ...memberTarget(), resourceSub });
      expect(ladder.find((s) => s.stage === "dept_poc")?.approverIds).toEqual([U_HR_POC]);
    }
    await clearMemberApprovers();
  });

  it("配置里的申请人本人不会给自己批（dedupeLadder 排除）", async () => {
    await setResourceApprovers({
      productionId: prodId, resourceType: "member",
      deptIds: [], userIds: [U_REQUESTER, U_HR_PERSON], establishedBy: U_OWNER,
    });
    const stage = (await buildApprovalLadder(memberTarget())).find((s) => s.stage === "dept_poc");
    expect(stage?.approverIds).toEqual([U_HR_PERSON]);
    await clearMemberApprovers();
  });
});

describe("共享判据：findProducers", () => {
  it("配置面的门与阶梯的制作人级读同一份判据（谁改了两边一起变）", async () => {
    // #326 起 findProducers 从模块私有转出：审批阶梯的制作人级用它，
    // 「谁能配资源审批人」的门也用它。这条钉住的就是这层耦合——若哪天有人给
    // 其中一侧另写一份「制作人」判据，两处会悄悄分家，这里先红。
    const pool = getPool();
    await pool.query(
      `UPDATE production_member SET roles = ARRAY['制作人']
       WHERE production_id = $1 AND user_id = $2`,
      [prodId, U_HR_PERSON],
    );
    try {
      expect(await findProducers(prodId)).toContain(U_HR_PERSON);
      const ladder = await buildApprovalLadder(memberTarget());
      expect(ladder.find((s) => s.stage === "producer")?.approverIds).toContain(U_HR_PERSON);
    } finally {
      await pool.query(
        `UPDATE production_member SET roles = '{}' WHERE production_id = $1 AND user_id = $2`,
        [prodId, U_HR_PERSON],
      );
    }
  });
});

describe("覆盖式保存", () => {
  it("只换类型级行，不动建事件/建任务写的实例行", async () => {
    const pool = getPool();
    // 实例行：真实流程里由 assignEventManagingDepts 等写入，带具体 resource_id
    await addResourceDeptManage({
      productionId: prodId, deptId: hrDeptId,
      resourceType: "event", resourceId: "evt-fixture",
      establishedBy: U_OWNER,
    });
    await setResourceApprovers({
      productionId: prodId, resourceType: "event",
      deptIds: [hrDeptId], userIds: [], establishedBy: U_OWNER,
    });
    // 清空类型级配置
    await setResourceApprovers({
      productionId: prodId, resourceType: "event",
      deptIds: [], userIds: [], establishedBy: U_OWNER,
    });

    const { rows } = await pool.query<{ resource_id: string }>(
      `SELECT resource_id FROM resource_dept_manage
       WHERE production_id = $1 AND resource_type = 'event'`,
      [prodId],
    );
    expect(rows.map((r) => r.resource_id)).toEqual(["evt-fixture"]);
  });

  it("listResourceApprovers 只回类型级行", async () => {
    await setResourceApprovers({
      productionId: prodId, resourceType: "member",
      deptIds: [hrDeptId], userIds: [U_HR_PERSON], establishedBy: U_OWNER,
    });
    const entries = await listResourceApprovers(prodId);
    const member = entries.find((e) => e.resourceType === "member");
    expect(member).toEqual({ resourceType: "member", deptIds: [hrDeptId], userIds: [U_HR_PERSON] });
    // 上一个用例留下的 event 实例行不该出现在配置面里
    expect(entries.find((e) => e.resourceType === "event")).toBeUndefined();
    await clearMemberApprovers();
  });
});
