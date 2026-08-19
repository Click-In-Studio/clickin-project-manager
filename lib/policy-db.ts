/**
 * 策略配置读写（#236 基建）。词汇表在 lib/policy-keys.ts，设计见 MindWeave
 * 《权限系统-不变量与策略汇总》§2.0 / §5 / §6。
 *
 * 三件事：
 *   ① **落全量**：ensureProductionPolicies 把词汇表里每个键都物化成行。建演出时调，
 *      策略中心读接口进入时也调（自愈补齐——新加的键、以及本表上线前就存在的演出）。
 *      为什么不稀疏：缺行回落代码默认 ⇒ 改一次代码默认值会**静默改变所有未显式配置过
 *      该键的存量演出的行为**，且不留痕迹。
 *   ② **读**：写点（形状 A）/ 判定端（形状 C）/ 边变更副作用点（形状 L）各取所需。
 *      行缺失时**防御性**回落代码默认——那是不该发生的路径，不是设计路径。
 *   ③ **写**：白名单校验 + 事务内 upsert + 审计留痕（who / when / 旧值→新值）。
 *
 * **本模块不碰任何 grant 行、不改任何门**——形状 A 只把「发不发」的答案交给写点，
 * 由写点自己去发；形状 C/L 只交出档位。铁律：开关不否决已有行，也不改变一行的含义。
 */
import { getPool } from "./pg";
import type { Pool, PoolClient } from "pg";
import type { GrantVerb } from "./grant-check";
import {
  POLICY_KEYS, POLICY_ON, policyDef, isLegalValue, defaultValueOf, configurableRows,
  type PolicyKeyDef,
} from "./policy-keys";

type Queryable = Pool | PoolClient;

export type PolicyRowOut = {
  key: string;
  value: string;
  shape: PolicyKeyDef["shape"];
  values: readonly string[];
  defaultValue: string;
  isDefault: boolean;
  label: string;
  help: string;
};

/**
 * 把词汇表里**缺行**的键按代码默认物化。已有行一律不动——物化那一刻就冻结了当时的
 * 默认值，此后改代码默认不会回溯任何演出，这正是「落全量」要买的东西。
 *
 * `overrides` 供项目模版建演出时改初始档位（`lib/template-seeders/policy.ts`）：它只
 * 影响**这次物化写下的值**，对已有行同样不动。合法性由调用方保证（模版有 CI 棘轮）。
 */
export async function ensureProductionPolicies(
  productionId: string,
  db: Queryable = getPool(),
  overrides: Readonly<Record<string, string>> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO production_policy (production_id, policy_key, value)
     SELECT $1, k.key, k.val
     FROM UNNEST($2::text[], $3::text[]) AS k(key, val)
     ON CONFLICT (production_id, policy_key) DO NOTHING`,
    [
      productionId,
      POLICY_KEYS.map((d) => d.key),
      POLICY_KEYS.map((d) => overrides[d.key] ?? d.defaultValue),
    ],
  );
}

/** 演出的全部策略值。缺行按代码默认补进返回值（不写库——写库是 ensure 的职责）。 */
export async function getPolicyMap(
  productionId: string,
  db: Queryable = getPool(),
): Promise<Map<string, string>> {
  const { rows } = await db.query<{ policy_key: string; value: string }>(
    `SELECT policy_key, value FROM production_policy WHERE production_id = $1`,
    [productionId],
  );
  const map = new Map(rows.map((r) => [r.policy_key, r.value]));
  for (const def of POLICY_KEYS) if (!map.has(def.key)) map.set(def.key, def.defaultValue);
  return map;
}

export async function getPolicyValue(
  productionId: string,
  key: string,
  db: Queryable = getPool(),
): Promise<string> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM production_policy WHERE production_id = $1 AND policy_key = $2`,
    [productionId, key],
  );
  return rows[0]?.value ?? defaultValueOf(key) ?? "";
}

/** on/off 型键的便捷读法（形状 C/L 的多档键不要用这个）。 */
export async function isPolicyOn(
  productionId: string,
  key: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  return (await getPolicyValue(productionId, key, db)) === POLICY_ON;
}

/**
 * 形状 A 的写点助手：把「该发的行集」按开关裁一遍。
 *
 * 语义是**集合运算**，不是过滤——两个方向都要走：
 *   - 行集里的可配行，开关关 ⇒ 去掉
 *   - **不在**行集里的可配行，开关开 ⇒ 加上（`event.creator:publication@create`、
 *     `*@delete` 这类默认关的键就是靠这条生效的）
 *   - 不在词汇表里的行 = M-14 底座或其他不可配行 ⇒ 原样保留
 *
 * 调用方把 `*_LEVEL_ROW_SETS` 的某一档传进来即可；**不要反过来去改那张表**——它同时
 * 是审批发行与「上级有没有这个权限」的定义（M-12），裁到表上会连带砍掉审批面。
 */
export async function policyFilteredRows(
  productionId: string,
  type: string,
  actor: string,
  baseRows: ReadonlyArray<readonly [string, string]>,
  db: Queryable = getPool(),
): Promise<Array<readonly [string, GrantVerb]>> {
  const defs = configurableRows(type, actor);
  if (defs.length === 0) return baseRows.map((r) => [r[0], r[1] as GrantVerb] as const);

  const map = await getPolicyMap(productionId, db);
  const out = new Map<string, readonly [string, GrantVerb]>(
    baseRows.map((r) => [`${r[0]}@${r[1]}`, [r[0], r[1] as GrantVerb] as const]),
  );
  for (const def of defs) {
    const { sub, verb } = def.a!.row;
    const id = `${sub}@${verb}`;
    if (map.get(def.key) === POLICY_ON) out.set(id, [sub, verb] as const);
    else out.delete(id);
  }
  return [...out.values()];
}

/** 配置中心读接口用：当前值 + 元信息（合法取值、默认值、是否仍是默认、文案）。 */
export async function listPolicies(productionId: string): Promise<PolicyRowOut[]> {
  await ensureProductionPolicies(productionId);
  const map = await getPolicyMap(productionId);
  return POLICY_KEYS.map((def) => {
    const value = map.get(def.key) ?? def.defaultValue;
    return {
      key: def.key, value, shape: def.shape, values: def.values,
      defaultValue: def.defaultValue, isDefault: value === def.defaultValue,
      label: def.label, help: def.help,
    };
  });
}

export type PolicyWriteResult =
  | { ok: true; changed: { key: string; from: string; to: string }[] }
  | { ok: false; error: string };

/**
 * 批量改策略。整体事务：要么全改要么全不改——配置中心一次提交往往同时设多个键
 * （一道语义题设多个键，§6.4 纪律 3），半截生效会配出自相矛盾的组合。
 */
export async function setPolicies(
  productionId: string,
  changes: Record<string, string>,
  changedBy: string,
): Promise<PolicyWriteResult> {
  const entries = Object.entries(changes);
  if (entries.length === 0) return { ok: true, changed: [] };

  for (const [key, value] of entries) {
    const def = policyDef(key);
    if (!def) return { ok: false, error: `未知策略键：${key}` };
    if (!isLegalValue(key, value)) {
      return { ok: false, error: `策略键 ${key} 不接受取值 ${value}（合法：${def.values.join(" / ")}）` };
    }
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await ensureProductionPolicies(productionId, client);
    const changed: { key: string; from: string; to: string }[] = [];
    for (const [key, value] of entries) {
      const { rows } = await client.query<{ value: string }>(
        `SELECT value FROM production_policy
         WHERE production_id = $1 AND policy_key = $2 FOR UPDATE`,
        [productionId, key],
      );
      const from = rows[0]?.value ?? defaultValueOf(key)!;
      if (from === value) continue;
      await client.query(
        `UPDATE production_policy
         SET value = $3, updated_by = $4, updated_at = NOW()
         WHERE production_id = $1 AND policy_key = $2`,
        [productionId, key, value, changedBy],
      );
      await client.query(
        `INSERT INTO production_policy_audit
           (production_id, policy_key, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [productionId, key, from, value, changedBy],
      );
      changed.push({ key, from, to: value });
    }
    await client.query("COMMIT");
    return { ok: true, changed };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type PolicyAuditRow = {
  policyKey: string;
  oldValue: string;
  newValue: string;
  changedBy: string | null;
  changedAt: string;
};

export async function listPolicyAudit(
  productionId: string,
  limit = 50,
): Promise<PolicyAuditRow[]> {
  const { rows } = await getPool().query<{
    policy_key: string; old_value: string; new_value: string;
    changed_by: string | null; changed_at: Date;
  }>(
    `SELECT policy_key, old_value, new_value, changed_by, changed_at
     FROM production_policy_audit
     WHERE production_id = $1
     ORDER BY changed_at DESC, id DESC
     LIMIT $2`,
    [productionId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    policyKey: r.policy_key, oldValue: r.old_value, newValue: r.new_value,
    changedBy: r.changed_by, changedAt: r.changed_at.toISOString(),
  }));
}
