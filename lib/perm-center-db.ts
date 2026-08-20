import { getPool } from "./pg";
import { parseNodeKey } from "./grant-template";
import { resourceLabels } from "./resource-directory";

// 管理后台·权限中心数据层：部门权限行（production_dept_permission 区间）
// 与权限键词汇（resource_permission_level + 全库在用键的 sub 面）。

/** 这一行由谁在管（#274）。词汇与语义见 db/migrate-dept-permission-source.sql。 */
export type DeptPermissionSource = "manual" | "template" | "resource";

export type DeptPermissionRow = {
  key: string;
  source: DeptPermissionSource;
};

/** 全项目部门权限行：dept_id → 行（含来源）。 */
export async function listDeptPermissionRows(
  productionId: string,
): Promise<Record<string, DeptPermissionRow[]>> {
  const res = await getPool().query<{ dept_id: string; permission_key: string; source: DeptPermissionSource }>(
    `SELECT dept_id, permission_key, source FROM production_dept_permission
     WHERE production_id = $1 ORDER BY source, permission_key`,
    [productionId],
  );
  const out: Record<string, DeptPermissionRow[]> = {};
  for (const r of res.rows) {
    (out[r.dept_id] ??= []).push({ key: r.permission_key, source: r.source });
  }
  return out;
}

/**
 * 全量替换一个部门**人管的**权限行（多退少补，事务）。
 *
 * ⚠ DELETE 必须限定 `source = 'manual'`：另两类行由声明表与资源归属信号在管，管理面
 * 的编辑列表里根本不显示它们（折叠只读），提交的 keys 自然不含——若不限定，每次在这儿
 * 点一下就会把整批实例行删空，而且下次传播又补回来，`resource_dept_manage` 与区间行
 * 从此打架。#274 之前正是靠「UI 把所有键都显示、原样提交回来」才没出事。
 */
export async function setDeptPermissionRows(
  productionId: string,
  deptId: string,
  keys: string[],
): Promise<void> {
  const uniq = [...new Set(keys)];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM production_dept_permission
       WHERE production_id = $1 AND dept_id = $2 AND source = 'manual'
         AND permission_key <> ALL($3::text[])`,
      [productionId, deptId, uniq],
    );
    for (const key of uniq) {
      // 撞上已由声明/归属在管的同一枚键时不降级它（DO NOTHING）——那一行的归属没变
      await client.query(
        `INSERT INTO production_dept_permission (production_id, dept_id, permission_key, source)
         VALUES ($1, $2, $3, 'manual') ON CONFLICT (dept_id, permission_key) DO NOTHING`,
        [productionId, deptId, key],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── 折叠视图（#274）────────────────────────────────────────────────────────────
//
// 部门权限列表里混着两类行：人管的（在这儿编辑）与别处管的（声明行实例化、资源归属/
// 分享面发的）。后者按资源实例成组，一场演出跑几个月能堆出几百条——事件那条通道是
// 「每个事件 × 每个归属部门 = 2 行」。平铺会把真正要人看的那十几行淹掉。
//
// 分组在服务端做：键的文法（node:<type>/<id>[/<sub>]@<verb>）只在服务端有解析器，
// 客户端不该再抄一份正则。

export type DeptPermissionGroup = {
  source: Exclude<DeptPermissionSource, "manual">;
  resourceType: string;
  resourceId: string;
  /** 实例名（查不到则回落 id——资源可能已删，行还在等 sweep）。 */
  label: string;
  keys: string[];
};

export type DeptPermissionView = {
  /** 人管的行：管理面直接增删，形状不限（制作人有权手动发实例键）。 */
  manual: string[];
  /** 别处管的行，按 (来源, 资源实例) 成组。 */
  groups: DeptPermissionGroup[];
};

/** 权限中心部门 tab 用：dept_id → { 人管的行, 按实例分组的行 }。 */
export async function listDeptPermissionView(
  productionId: string,
): Promise<Record<string, DeptPermissionView>> {
  const rows = await listDeptPermissionRows(productionId);

  // 先扫一遍需要哪些类型的名字，按类型批量取（每类一条查询，不是每行一条）
  const types = new Set<string>();
  for (const list of Object.values(rows)) {
    for (const r of list) {
      if (r.source === "manual") continue;
      const parsed = parseNodeKey(r.key);
      if (parsed && parsed.resourceId !== "*") types.add(parsed.resourceType);
    }
  }
  const labels = new Map<string, Map<string, string>>();
  await Promise.all([...types].map(async (t) => labels.set(t, await resourceLabels(productionId, t))));

  const out: Record<string, DeptPermissionView> = {};
  for (const [deptId, list] of Object.entries(rows)) {
    const manual: string[] = [];
    const byGroup = new Map<string, DeptPermissionGroup>();
    for (const r of list) {
      const parsed = r.source === "manual" ? null : parseNodeKey(r.key);
      // 非 manual 但键形解析不出实例（通配 id / 非法键）：当人管的显示，
      // 宁可多给一个可编辑入口，也不要让一行彻底没有出口。
      if (!parsed || parsed.resourceId === "*") { manual.push(r.key); continue; }
      const gid = `${r.source}:${parsed.resourceType}:${parsed.resourceId}`;
      const group = byGroup.get(gid) ?? {
        source: r.source as Exclude<DeptPermissionSource, "manual">,
        resourceType: parsed.resourceType,
        resourceId: parsed.resourceId,
        label: labels.get(parsed.resourceType)?.get(parsed.resourceId) ?? parsed.resourceId,
        keys: [],
      };
      group.keys.push(r.key);
      byGroup.set(gid, group);
    }
    out[deptId] = {
      manual,
      groups: [...byGroup.values()].sort(
        (a, b) => a.resourceType.localeCompare(b.resourceType) || a.label.localeCompare(b.label, "zh"),
      ),
    };
  }
  return out;
}

export type PermissionVocabulary = {
  /** resource_type → 合法动词（词汇表序） */
  verbs: Record<string, string[]>;
  /** resource_type → 全库在用的 sub 面（含保留段），供 picker 提示 */
  subs: Record<string, string[]>;
};

/** 权限键词汇：动词=resource_permission_level 闭集；sub 面从三张区间表在用键
 *  聚合（提示性，picker 仍允许自由输入）。 */
export async function getPermissionVocabulary(productionId: string): Promise<PermissionVocabulary> {
  const pool = getPool();
  const [levelRes, keysRes] = await Promise.all([
    pool.query<{ resource_type: string; permission_level: string }>(
      `SELECT resource_type, permission_level FROM resource_permission_level
       ORDER BY resource_type, sort_order`,
    ),
    pool.query<{ permission_key: string }>(
      // 模板层不再入库（grant_template 已退役 #163）：sub 面提示改从演出内三张区间表
      // 聚合。新演出建出来就带全套模版行，聚合结果与此前等价。
      `SELECT DISTINCT prp.permission_key FROM production_role_permission prp
       JOIN production_role pr ON pr.id = prp.role_id WHERE pr.production_id = $1
       UNION
       SELECT DISTINCT permission_key FROM production_dept_permission WHERE production_id = $1
       UNION
       SELECT DISTINCT permission FROM production_member_permission WHERE production_id = $1`,
      [productionId],
    ),
  ]);

  const verbs: Record<string, string[]> = {};
  for (const r of levelRes.rows) {
    (verbs[r.resource_type] ??= []).push(r.permission_level);
  }

  const subSets: Record<string, Set<string>> = {};
  for (const r of keysRes.rows) {
    const parsed = parseNodeKey(r.permission_key);
    if (!parsed || !(parsed.resourceType in verbs)) continue;
    (subSets[parsed.resourceType] ??= new Set()).add(parsed.resourceSub);
  }
  const subs: Record<string, string[]> = {};
  for (const [type, set] of Object.entries(subSets)) {
    subs[type] = [...set].sort();
  }
  return { verbs, subs };
}
