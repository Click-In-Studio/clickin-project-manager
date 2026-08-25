/**
 * 资源审批人配置（#262）——「这类资源的申请，第一级找谁」的配置面。
 *
 * 存的就是既有的 resource_dept_manage / resource_person_manage 两张表，只是把
 * resource_id / resource_sub 都填 '*'（类型级行）。不新开表的理由：
 * buildApprovalLadder 的 dept_poc 级本来就查这两张表、且查询带 '*' 通配
 * （approval-routing.ts 的 findManagingDeptIds / findPersonManagers），配置写进去
 * 即刻进阶梯——路由、鉴权、schema 一行都不用改。
 *
 * **写进来不只是「谁来批」，也是「谁在管」。** 这两张表同时是：
 *   - 免审批区间 manage 档的判据（resource-grant-db.ts checkNodeFreeApprovalZone。
 *     event / report / task 三型在用，且条件是 resource_id IN (实例, '*')——类型级
 *     行会命中全部实例）
 *   - self_confirmed 授权的存续凭据（dept-db.ts recomputeAndRevokeGrants 的 ①②）
 * 即：把某部门配成 event 的审批方，等于该部门 POC 获得全部 event 的 manage 档自确认
 * 资格。这是 resource_dept_manage 的原意（「共管」），不是副作用——但配置面必须把这
 * 句话写在人眼前，否则配的人以为自己只是指了个审批人。
 *
 * **production / producer 不可委派**：这两个是演出本身与制作人域，没有除 owner 以外
 * 的归属方。它们的 sensitive 面恒直达 owner（approval-routing 的分流），非 sensitive
 * 面（production 的 config 面等）天然落到阶梯第五级制作人——两条路都不需要配置，
 * 配了也只会在账本里留一条骗不了路由、只骗人的记录。故在此拒收。
 *
 * 类型级行（'*','*'）只由人经此模块写入：自动流程（建事件/建任务/建报告）写的都是带
 * 具体 resource_id 的实例行（resource-grant-db.ts）。所以覆盖式保存限定 '*'/'*' 两列
 * 就够，不会误删别处在管的实例归属。
 */

import { getPool } from "./pg";

/** 演出本身与制作人域：没有第二个归属方，审批人不可配（理由见文件头）。 */
export const NON_DELEGABLE_RESOURCE_TYPES: readonly string[] = ["production", "producer"];

export function isDelegableResourceType(resourceType: string): boolean {
  return !NON_DELEGABLE_RESOURCE_TYPES.includes(resourceType);
}

export type ResourceApproverEntry = {
  resourceType: string;
  /** 审批部门：进阶梯的是该部门的 POC，不是全体部门成员。 */
  deptIds: string[];
  /** 个人审批人。 */
  userIds: string[];
};

export type ResourceApproverErrorCode =
  | "non_delegable"
  | "unknown_type"
  | "bad_dept"
  | "bad_user";

export class ResourceApproverError extends Error {
  constructor(public code: ResourceApproverErrorCode) {
    super(code);
    this.name = "ResourceApproverError";
  }
}

const ERROR_MESSAGES: Record<ResourceApproverErrorCode, string> = {
  non_delegable: "演出本身与制作人域的审批不可委派（敏感面恒由所有者审批，其余落制作人）",
  unknown_type: "未登记的资源类型",
  bad_dept: "审批部门不属于本演出",
  bad_user: "审批人不是本演出成员",
};

export function resourceApproverErrorMessage(code: ResourceApproverErrorCode): string {
  return ERROR_MESSAGES[code];
}

/**
 * 已登记词汇但判定侧不读的死类型——清册里要滤掉，否则配了个永远不生效的审批人。
 * tech_req：REST 化时任务类型定为 'task'，tech_req 的动词行留在词表里没删，
 * 判定侧一律只读 'task'（见 resource-grant-db.ts「曾误写 resource_type='tech_req'
 * 死行」那段）。它今天只作为通知的 entity_type 存活，与权限类型不是一个命名空间。
 */
const DEAD_RESOURCE_TYPES: readonly string[] = ["tech_req"];

/** 可配审批人的资源类型清册：已登记动词行的类型全集，减去不可委派的与死类型。 */
export async function listDelegableResourceTypes(): Promise<string[]> {
  const { rows } = await getPool().query<{ resource_type: string }>(
    `SELECT DISTINCT resource_type FROM resource_permission_level ORDER BY resource_type`,
  );
  return rows
    .map((r) => r.resource_type)
    .filter((t) => isDelegableResourceType(t) && !DEAD_RESOURCE_TYPES.includes(t));
}

/**
 * 本演出已配的类型级审批人。只回 id，名字由调用方用已有的部门/成员名单解析
 * （权限中心两份名单都已在手，再 join 一次只会多一份会漂的真相）。
 */
export async function listResourceApprovers(productionId: string): Promise<ResourceApproverEntry[]> {
  const pool = getPool();
  const [deptRes, personRes] = await Promise.all([
    pool.query<{ resource_type: string; dept_id: string }>(
      `SELECT resource_type, dept_id FROM resource_dept_manage
       WHERE production_id = $1 AND resource_id = '*' AND resource_sub = '*'
       ORDER BY resource_type`,
      [productionId],
    ),
    pool.query<{ resource_type: string; user_id: string }>(
      `SELECT resource_type, user_id FROM resource_person_manage
       WHERE production_id = $1 AND resource_id = '*' AND resource_sub = '*'
       ORDER BY resource_type`,
      [productionId],
    ),
  ]);

  const byType = new Map<string, ResourceApproverEntry>();
  const entry = (type: string): ResourceApproverEntry => {
    let e = byType.get(type);
    if (!e) { e = { resourceType: type, deptIds: [], userIds: [] }; byType.set(type, e); }
    return e;
  };
  for (const r of deptRes.rows) entry(r.resource_type).deptIds.push(r.dept_id);
  for (const r of personRes.rows) entry(r.resource_type).userIds.push(r.user_id);
  return [...byType.values()].sort((a, b) => a.resourceType.localeCompare(b.resourceType));
}

/**
 * 覆盖式保存某类型的审批人。校验放在这里而不是只在路由：任何调用方都过这道门
 * （与 submitAccessRequest 的 TTL 白名单同一个理由）。
 *
 * 删+插同事务：中途失败不能留「旧的删了、新的没进」的空配置——那会让这类申请
 * 悄悄退回制作人兜底，且没有任何地方看得出来发生过。
 */
export async function setResourceApprovers(params: {
  productionId: string;
  resourceType: string;
  deptIds: string[];
  userIds: string[];
  establishedBy: string;
}): Promise<ResourceApproverEntry> {
  const { productionId, resourceType, establishedBy } = params;
  const deptIds = [...new Set(params.deptIds)];
  const userIds = [...new Set(params.userIds)];

  if (!isDelegableResourceType(resourceType)) {
    throw new ResourceApproverError("non_delegable");
  }

  const pool = getPool();
  const known = await pool.query(
    `SELECT 1 FROM resource_permission_level WHERE resource_type = $1 LIMIT 1`,
    [resourceType],
  );
  if (known.rows.length === 0) throw new ResourceApproverError("unknown_type");

  // 部门必须属于本演出：dept_id 的 FK 只保证部门存在，不保证是**这场**演出的部门。
  if (deptIds.length > 0) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM production_dept WHERE production_id = $1 AND id = ANY($2::uuid[])`,
      [productionId, deptIds],
    );
    if (rows.length !== deptIds.length) throw new ResourceApproverError("bad_dept");
  }

  // 审批人必须是本演出成员：app_user 的 FK 同样只保证账号存在。非成员进了阶梯，
  // 通知发得出去、页面进不来，申请就卡死在那一级直到超时。
  if (userIds.length > 0) {
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM production_member
       WHERE production_id = $1 AND user_id = ANY($2::uuid[])`,
      [productionId, userIds],
    );
    if (rows.length !== userIds.length) throw new ResourceApproverError("bad_user");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM resource_dept_manage
       WHERE production_id = $1 AND resource_type = $2 AND resource_id = '*' AND resource_sub = '*'`,
      [productionId, resourceType],
    );
    await client.query(
      `DELETE FROM resource_person_manage
       WHERE production_id = $1 AND resource_type = $2 AND resource_id = '*' AND resource_sub = '*'`,
      [productionId, resourceType],
    );
    if (deptIds.length > 0) {
      await client.query(
        `INSERT INTO resource_dept_manage
           (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
         SELECT $1, d, $2, '*', '*', $4 FROM UNNEST($3::uuid[]) AS d
         ON CONFLICT DO NOTHING`,
        [productionId, resourceType, deptIds, establishedBy],
      );
    }
    if (userIds.length > 0) {
      await client.query(
        `INSERT INTO resource_person_manage
           (production_id, user_id, resource_type, resource_id, resource_sub, established_by)
         SELECT $1, u, $2, '*', '*', $4 FROM UNNEST($3::uuid[]) AS u
         ON CONFLICT DO NOTHING`,
        [productionId, resourceType, userIds, establishedBy],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return { resourceType, deptIds, userIds };
}
