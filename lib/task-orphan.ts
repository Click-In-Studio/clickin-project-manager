/**
 * 孤儿任务处置（#236 形状 L —— 生命周期规则，**不碰权限**）。
 *
 * 设计见 MindWeave《权限系统-不变量与策略汇总》M-15(e) / §5.3。
 *
 * 形状 L 的纪律：本模块**不读写任何 grant 行、不改变任何门**。它只决定「边消失之后
 * 数据变成什么样」。若哪天某个「生命周期」需求需要碰权限才能实现，那它就不是 L，
 * 是伪装的 A/C，得退回去重新分类。
 *
 * ## 为什么 task 的「唯一边」是结构上白送的
 *
 * M-15(e) 说级联删除只在本体失去**最后一个**宿主边时允许，判据是**宿主集合降为空**
 * 而不是边计数归零。对 task 来说这条自动成立：`task.event_id` 是**单个可空 FK**，
 * 宿主集合最多一个元素，失去它必然降为空——不存在「还挂在别的 event 上」的情形，
 * 所以「A event 的权限者销毁也绑在 B event 上的 task」这个越权场景**结构上不可能**。
 *
 * `task_schedule_item` 那层才是多对多，但它是**宿主内的细锚点**（schema 注释：
 * 「应用层不变量：item 必须属于 task.event_id」），删一个 schedule item 不构成失去
 * 宿主——已复核 `deleteScheduleItem` 只删 `event_schedule_item` 行，`task.event_id`
 * 纹丝不动。**只有 event 宿主关系的变更能触发本模块**。
 *
 * ## 两条入口
 *
 *   1. 删 event —— FK 是 `ON DELETE SET NULL`，**数据库层会静默把 task 变成孤儿**，
 *      应用代码看不见。所以必须在删除**之前**把受影响的 task 捞出来，同一事务内处置。
 *   2. 解绑（PATCH task { eventId: null }）—— 应用层显式。
 *
 * ## 「被动过」判据
 *
 * 未被动过 = `status='awaiting'`（自动建出的空白占位）∧ 正文为空 ∧ 无 assignee。
 * 三者齐备才算「纯垃圾」——有人填过内容、推进过状态、或被指派过，都算部门已经
 * 开工，删掉等于抹掉工作记录。
 */
import type { PoolClient } from "pg";
import { getPolicyValue } from "./policy-db";
import {
  ORPHAN_TASK_KEEP, ORPHAN_TASK_MIDDLE, ORPHAN_TASK_DELETE,
} from "./policy-keys";

export type OrphanOutcome = { deleted: string[]; marked: string[] };

/**
 * 处置一批**即将或已经**失去宿主 event 的 task。
 *
 * 必须在**删边事务内**调用（而不是异步）：异步会留窗口期，「删完还在列表里」的
 * 不一致会直接暴露给用户；量级是单个 event 的关联 task，事务内不构成负担。
 *
 * 幂等：重复调用只会把仍存在的孤儿再标一次时间戳，不会误删已开工的任务。
 */
export async function disposeOrphanedTasks(
  client: PoolClient,
  productionId: string,
  taskIds: readonly string[],
): Promise<OrphanOutcome> {
  if (taskIds.length === 0) return { deleted: [], marked: [] };

  const disposition = await getPolicyValue(
    productionId, "policy.orphan_task_disposition", client,
  );

  // keep 档：一律留为孤儿，连标记都不打（剧组明确表示不想被提醒）
  if (disposition === ORPHAN_TASK_KEEP) {
    return { deleted: [], marked: [] };
  }

  let toDelete: string[];
  if (disposition === ORPHAN_TASK_DELETE) {
    toDelete = [...taskIds];
  } else {
    // 默认档（ORPHAN_TASK_MIDDLE）：只删没人动过的。
    // 三条齐备才算纯垃圾——upsertAwaitingTechReqs 建的空白占位就是这个形态。
    const { rows } = await client.query<{ id: string }>(
      `SELECT t.id FROM task t
       WHERE t.id = ANY($1::text[])
         AND t.production_id = $2
         AND t.status = 'awaiting'
         AND COALESCE(btrim(t.description), '') = ''
         AND NOT EXISTS (SELECT 1 FROM task_assignee ta WHERE ta.task_id = t.id)`,
      [taskIds, productionId],
    );
    toDelete = rows.map((r) => r.id);
  }

  if (toDelete.length > 0) {
    await client.query(
      `DELETE FROM task WHERE id = ANY($1::text[]) AND production_id = $2`,
      [toDelete, productionId],
    );
  }

  // 活下来的标记为待处理，交给部门 POC 决定删还是转挂
  const keep = taskIds.filter((id) => !toDelete.includes(id));
  if (keep.length > 0) {
    await client.query(
      `UPDATE task SET orphaned_at = NOW()
       WHERE id = ANY($1::text[]) AND production_id = $2 AND orphaned_at IS NULL`,
      [keep, productionId],
    );
  }
  return { deleted: toDelete, marked: keep };
}

/** 删 event 前捞出会因此失去宿主的 task（FK 是 ON DELETE SET NULL，删完就查不到了）。 */
export async function tasksLosingHost(
  client: PoolClient,
  productionId: string,
  eventId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM task WHERE production_id = $1 AND event_id = $2`,
    [productionId, eventId],
  );
  return rows.map((r) => r.id);
}

/** 重新绑定到某个 event 时清除孤儿标记——它记的是「当前没有宿主」，不是历史。 */
export async function clearOrphanMark(
  client: PoolClient,
  productionId: string,
  taskId: string,
): Promise<void> {
  await client.query(
    `UPDATE task SET orphaned_at = NULL
     WHERE id = $1 AND production_id = $2 AND orphaned_at IS NOT NULL`,
    [taskId, productionId],
  );
}
