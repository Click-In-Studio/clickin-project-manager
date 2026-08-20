/**
 * 用户组的冻结层。
 *
 * ## 冻结做什么
 *
 * 把「这个 event 引用的每个组，此刻解析出来的成员与 POC」物化成快照。之后该 event
 * 读快照，组本身怎么改（改名、换 POC、加人、停用）都与它无关——这正是用户要的
 * 「之后用户组可以独立更改但是不会影响到该 event」。
 *
 * ## 冻结不做什么
 *
 * **不解绑组和 event 的关系。** schedule_item_group 与 task.group_id 这些边在冻结
 * 前后完全不变，冻结只是往快照表写行。读取时按「有没有生效中的快照」分流。
 *
 * **不替人决定善后找谁。** 判定端没有「POC 失效 → 自动落到某部门现任 POC」这种
 * 回退链。快照忠实保存关系（谁、以什么身份、当时 POC 是谁），当前有效性由
 * {@link describeFrozenGroups} 标注出来，找谁是 PSM 的判断——尤其项目复杂或牵扯
 * 多个部门时，机器做不出这个决定。
 *
 * ## 三条不变量
 *
 * 1. **物化必须发生在 deadline 那一刻**，不能懒惰计算。做成派生谓词的话，deadline
 *    到首次读取之间的部门人员变动会污染快照。所以有 cron。
 * 2. **refreeze 追加不覆盖**：unfreeze 置 released_at，再冻插新一版。覆盖式 UPDATE
 *    会让上一次冻下来的事实消失。
 * 3. **POC 分裂**：追责读快照里的 POC（当时谁负责），善后看关系图找现在的人。
 *    冻结后权限不自动漂移——失效 POC 的 task 要有人显式接手，走 owner 旁路或申请通道。
 */

import { getPool } from "./pg";
import type { PoolClient } from "pg";

/** 冻结宽限期：散场后还要补记「临时来的那个 runner」，所以不在 end_time 当刻就冻。 */
export const FREEZE_GRACE_DAYS = 7;

export type FrozenGroupMember = {
  userId: string | null;
  userName: string;
  /** null = 直接个人成员，不是被某个部门带进来的 */
  viaDeptId: string | null;
  viaDeptName: string | null;
};

export type FrozenGroup = {
  eventId: string;
  groupId: string;
  frozenAt: string;
  groupName: string;
  location: string;
  /** 当时的 POC —— 追责读这个，不是组的现任 POC */
  pocDeptId: string | null;
  pocDeptName: string | null;
  pocUserId: string | null;
  pocUserName: string | null;
  members: FrozenGroupMember[];
};

// ─── 状态查询 ─────────────────────────────────────────────────────────────────

/** 这个 event 有生效中快照的组 id。空集 = 未冻结，读取走实时解析。 */
export async function frozenGroupIds(eventId: string): Promise<Set<string>> {
  const res = await getPool().query<{ group_id: string }>(
    "SELECT group_id FROM event_group_freeze WHERE event_id = $1 AND released_at IS NULL",
    [eventId],
  );
  return new Set(res.rows.map(r => r.group_id));
}

/** 这个 (event, group) 是不是冻着的。 */
export async function isGroupFrozenForEvent(eventId: string, groupId: string): Promise<boolean> {
  const res = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM event_group_freeze
        WHERE event_id = $1 AND group_id = $2 AND released_at IS NULL
     ) AS exists`,
    [eventId, groupId],
  );
  return res.rows[0].exists;
}

export async function isEventFrozen(eventId: string): Promise<boolean> {
  return (await frozenGroupIds(eventId)).size > 0;
}

// ─── 快照读取 ─────────────────────────────────────────────────────────────────

/** 生效中快照里这个组当时有哪些人（去重后的 userId）。 */
export async function frozenGroupUserIds(eventId: string, groupId: string): Promise<string[]> {
  const res = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT m.user_id
       FROM event_group_freeze f
       JOIN event_group_freeze_member m
         ON m.event_id = f.event_id AND m.group_id = f.group_id AND m.frozen_at = f.frozen_at
      WHERE f.event_id = $1 AND f.group_id = $2 AND f.released_at IS NULL
        AND m.user_id IS NOT NULL`,
    [eventId, groupId],
  );
  return res.rows.map(r => r.user_id);
}

/** 生效中快照里这个组**当时**的 POC 是谁。追责用；善后不要用这个自动跳转。 */
export async function frozenGroupPocUserIds(eventId: string, groupId: string): Promise<string[]> {
  const res = await getPool().query<{ poc_user_id: string | null }>(
    `SELECT poc_user_id FROM event_group_freeze
      WHERE event_id = $1 AND group_id = $2 AND released_at IS NULL`,
    [eventId, groupId],
  );
  return res.rows.map(r => r.poc_user_id).filter((v): v is string => v !== null);
}

/**
 * 关系视图的数据源：冻结时的完整关系 + 每个节点的**当前**有效性。
 *
 * 这就是「系统保存关系、人做决定」那条的落实——它只回答「POC 张三，已离项目」
 * 「灯光部，仍在，现任 POC 是李四」这两句陈述，不回答「所以找李四」。
 */
export async function describeFrozenGroups(eventId: string): Promise<(FrozenGroup & {
  pocUserStillMember: boolean;
  pocDeptStillExists: boolean;
  pocDeptCurrentPocUserIds: string[];
  groupStillExists: boolean;
})[]> {
  const pool = getPool();
  const heads = await pool.query<{
    event_id: string; group_id: string; frozen_at: Date;
    group_name: string; location: string;
    poc_dept_id: string | null; poc_dept_name: string | null;
    poc_user_id: string | null; poc_user_name: string | null;
    poc_user_still_member: boolean; poc_dept_still_exists: boolean; group_still_exists: boolean;
  }>(
    `SELECT f.event_id, f.group_id, f.frozen_at, f.group_name, f.location,
            f.poc_dept_id, f.poc_dept_name, f.poc_user_id, f.poc_user_name,
            EXISTS (SELECT 1 FROM production_member pm
                     JOIN production_event pe ON pe.production_id = pm.production_id
                    WHERE pe.id = f.event_id AND pm.user_id = f.poc_user_id) AS poc_user_still_member,
            EXISTS (SELECT 1 FROM production_dept d WHERE d.id = f.poc_dept_id) AS poc_dept_still_exists,
            EXISTS (SELECT 1 FROM event_group g WHERE g.id = f.group_id)       AS group_still_exists
       FROM event_group_freeze f
      WHERE f.event_id = $1 AND f.released_at IS NULL
      ORDER BY f.group_name`,
    [eventId],
  );
  if (!heads.rows.length) return [];

  const members = await pool.query<{
    group_id: string; user_id: string | null; user_name: string;
    via_dept_id: string | null; via_dept_name: string | null;
  }>(
    `SELECT m.group_id, m.user_id, m.user_name, m.via_dept_id, m.via_dept_name
       FROM event_group_freeze f
       JOIN event_group_freeze_member m
         ON m.event_id = f.event_id AND m.group_id = f.group_id AND m.frozen_at = f.frozen_at
      WHERE f.event_id = $1 AND f.released_at IS NULL
      ORDER BY m.via_dept_name NULLS FIRST, m.user_name`,
    [eventId],
  );
  const byGroup = new Map<string, FrozenGroupMember[]>();
  for (const r of members.rows) {
    if (!byGroup.has(r.group_id)) byGroup.set(r.group_id, []);
    byGroup.get(r.group_id)!.push({
      userId: r.user_id, userName: r.user_name,
      viaDeptId: r.via_dept_id, viaDeptName: r.via_dept_name,
    });
  }

  // 部门现任 POC：只作为**陈述**提供给人看，判定端不沿着它跳转
  const deptIds = heads.rows.map(r => r.poc_dept_id).filter((v): v is string => v !== null);
  const currentByDept = new Map<string, string[]>();
  if (deptIds.length) {
    const cur = await pool.query<{ dept_id: string; user_id: string }>(
      `SELECT dept_id, user_id FROM production_dept_member
        WHERE dept_id = ANY($1::uuid[]) AND is_poc = true`,
      [deptIds],
    );
    for (const r of cur.rows) {
      if (!currentByDept.has(r.dept_id)) currentByDept.set(r.dept_id, []);
      currentByDept.get(r.dept_id)!.push(r.user_id);
    }
  }

  return heads.rows.map(r => ({
    eventId: r.event_id,
    groupId: r.group_id,
    frozenAt: r.frozen_at.toISOString(),
    groupName: r.group_name,
    location: r.location,
    pocDeptId: r.poc_dept_id,
    pocDeptName: r.poc_dept_name,
    pocUserId: r.poc_user_id,
    pocUserName: r.poc_user_name,
    members: byGroup.get(r.group_id) ?? [],
    pocUserStillMember: r.poc_user_still_member,
    pocDeptStillExists: r.poc_dept_still_exists,
    pocDeptCurrentPocUserIds: r.poc_dept_id ? currentByDept.get(r.poc_dept_id) ?? [] : [],
    groupStillExists: r.group_still_exists,
  }));
}

// ─── 冻结 / 解冻 ──────────────────────────────────────────────────────────────

/** 这个 event 引用了哪些组（两条通道：流程项、task 责任主体）。 */
async function referencedGroupIds(client: PoolClient, eventId: string): Promise<string[]> {
  const res = await client.query<{ group_id: string }>(
    `SELECT sig.group_id
       FROM schedule_item_group sig
       JOIN event_schedule_item esi ON esi.id = sig.item_id
      WHERE esi.event_id = $1
      UNION
     SELECT t.group_id FROM task t
      WHERE t.event_id = $1 AND t.group_id IS NOT NULL`,
    [eventId],
  );
  return res.rows.map(r => r.group_id);
}

/**
 * 冻结这个 event 引用的全部组。已有生效快照的组跳过（幂等，cron 可重跑）。
 *
 * 成员展开成人是必须的：保留 dept 引用等于没冻——部门加人照样漏进来，
 * 「不影响该 event」不成立。同时保留 via_dept_* 记下他当时以什么身份在场。
 */
export async function freezeEventGroups(
  eventId: string,
  frozenBy: string | null,
): Promise<{ frozen: string[] }> {
  const client = await getPool().connect();
  const frozen: string[] = [];
  try {
    await client.query("BEGIN");
    const already = await client.query<{ group_id: string }>(
      "SELECT group_id FROM event_group_freeze WHERE event_id = $1 AND released_at IS NULL",
      [eventId],
    );
    const skip = new Set(already.rows.map(r => r.group_id));

    for (const groupId of await referencedGroupIds(client, eventId)) {
      if (skip.has(groupId)) continue;
      // frozen_at 由这里给定而不是用列默认值 + RETURNING 回传：timestamptz 是微秒
      // 精度，经 JS Date 往返会掉到毫秒，回传去插 member 时对不上组合外键。
      const frozenAt = new Date().toISOString();
      const head = await client.query<{ frozen_at: Date }>(
        `INSERT INTO event_group_freeze
           (event_id, group_id, frozen_at, group_name, location,
            poc_dept_id, poc_dept_name, poc_user_id, poc_user_name, frozen_by)
         SELECT $1, g.id, $4::timestamptz, g.name, g.location,
                g.poc_dept_id,
                (SELECT d.name FROM production_dept d WHERE d.id = g.poc_dept_id),
                -- POC 部门型：把「当时该部门的实际 POC 那个人」一起冻下来。只记部门
                -- 的话，一年后追责追到的是现任而不是当时那位。多 POC 取定序第一个：
                -- 责任单点指主体唯一，落到自然人时取一个可追的代表。
                COALESCE(g.poc_user_id, (
                  SELECT pdm.user_id FROM production_dept_member pdm
                   WHERE pdm.dept_id = g.poc_dept_id AND pdm.is_poc = true
                   ORDER BY pdm.user_id LIMIT 1
                )),
                (SELECT COALESCE(NULLIF(up.display_name, ''), up.name)
                   FROM user_profile up
                  WHERE up.user_id = COALESCE(g.poc_user_id, (
                    SELECT pdm.user_id FROM production_dept_member pdm
                     WHERE pdm.dept_id = g.poc_dept_id AND pdm.is_poc = true
                     ORDER BY pdm.user_id LIMIT 1
                  ))),
                $3::uuid
           FROM event_group g
          WHERE g.id = $2
        RETURNING frozen_at`,
        [eventId, groupId, frozenBy, frozenAt],
      );
      if (!head.rows[0]) continue;   // 组已被删（未冻结引用不该出现，防御）

      await client.query(
        `INSERT INTO event_group_freeze_member
           (event_id, group_id, frozen_at, user_id, user_name, via_dept_id, via_dept_name)
         -- 直接个人成员：via_dept_* 为空
         SELECT $1::text, $2::uuid, $3::timestamptz, egm.user_id,
                COALESCE(NULLIF(up.display_name, ''), up.name, egm.user_id::text),
                NULL, NULL
           FROM event_group_member egm
           LEFT JOIN user_profile up ON up.user_id = egm.user_id
          WHERE egm.group_id = $2 AND egm.user_id IS NOT NULL
          UNION ALL
         -- 部门带入：记下他当时以哪个部门的身份在场，善后靠这条顺藤摸瓜
         SELECT $1::text, $2::uuid, $3::timestamptz, pdm.user_id,
                COALESCE(NULLIF(up.display_name, ''), up.name, pdm.user_id::text),
                d.id, d.name
           FROM event_group_member egm
           JOIN production_dept d ON d.id = egm.dept_id
           JOIN production_dept_member pdm ON pdm.dept_id = d.id
           LEFT JOIN user_profile up ON up.user_id = pdm.user_id
          WHERE egm.group_id = $2 AND egm.dept_id IS NOT NULL`,
        [eventId, groupId, frozenAt],
      );
      frozen.push(groupId);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { frozen };
}

/**
 * 解冻：把生效中的快照置 released_at，不删行。
 *
 * organizer 一看「嗯？怎么被冻了？我还要 extend 活动」就能解开——冻结是可逆的，
 * 所以它敢按 deadline 自动发生。解开之后再冻会插新一版，两版都留着。
 */
export async function unfreezeEventGroups(eventId: string): Promise<{ released: number }> {
  const res = await getPool().query(
    "UPDATE event_group_freeze SET released_at = now() WHERE event_id = $1 AND released_at IS NULL",
    [eventId],
  );
  return { released: res.rowCount ?? 0 };
}

// ─── cron ─────────────────────────────────────────────────────────────────────

/**
 * 到期未冻的 event 批量冻结。由内部 cron 端点调用。
 *
 * 取 end_time + 宽限期而不是 completed 状态：状态要人点，end_time 自然到达——
 * 「只要 organizer 忘了点」就是这个机制要消除的东西。
 */
export async function freezeExpiredEventGroups(): Promise<{ events: number; groups: number }> {
  const due = await getPool().query<{ id: string }>(
    `SELECT DISTINCT pe.id
       FROM production_event pe
      WHERE pe.end_time IS NOT NULL
        AND pe.end_time < now() - ($1 || ' days')::interval
        AND EXISTS (
          SELECT 1 FROM schedule_item_group sig
            JOIN event_schedule_item esi ON esi.id = sig.item_id
           WHERE esi.event_id = pe.id
          UNION ALL
          SELECT 1 FROM task t WHERE t.event_id = pe.id AND t.group_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_group_freeze f
           WHERE f.event_id = pe.id AND f.released_at IS NULL
        )`,
    [String(FREEZE_GRACE_DAYS)],
  );
  let groups = 0;
  for (const row of due.rows) {
    const { frozen } = await freezeEventGroups(row.id, null);
    groups += frozen.length;
  }
  return { events: due.rows.length, groups };
}
