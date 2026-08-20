/**
 * rundown 版面：列配置与条目表现。
 *
 * ## 这层为什么必须存在
 *
 * 组是跨 event 共享的实体（B 型是项目级常驻编制），所以「在这场排第几列、显不显示、
 * 钉不钉在左边」不能记在组上——记上去，上海站改一下北京站跟着变。版面是
 * (event, group) 这一层的事。
 *
 * ## 版面归 organizer，不归个人
 *
 * 全部走 hasEventContentEdit，与「给流程项安排人」同一把钥匙。原前端把这些塞在
 * localStorage 里，等于「我的 rundown 不是你的 rundown」——而 rundown 本来就是
 * organizer 定好、大家遵守的东西。
 *
 * ## 两种列
 *
 * 按人（绑一个用户组）或按地点（匹配 event_schedule_item.location）。地点是事项的
 * 属性不是组的属性——一个组的人 9 点在主剧场、14 点在 A3——所以「地点列」是筛选
 * 条件，不是一个存起来的地点实体。
 */

import { getPool } from "./pg";

export type RundownColumn = {
  id: string;
  /** 二选一：绑组的列（按人）或地点列（按 item.location 筛） */
  groupId: string | null;
  matchLocation: string | null;
  orderIndex: number;
  isVisible: boolean;
  /** 横向滚动时钉在左侧。与冻结快照无关。 */
  isPinned: boolean;
};

export type RundownPlacement = {
  /** 与前端 entryKey 的 `item:` / `task:` 前缀对应 */
  entryType: "item" | "task";
  entryId: string;
  color: string | null;
  /** 手动钉到这几列（entryLaneOverrides）；空 = 按匹配规则自动落列 */
  pinnedColumnIds: string[];
};

export class RundownError extends Error {
  constructor(readonly reason: "bad_column" | "bad_entry", message: string) {
    super(message);
  }
}

// ─── 读 ───────────────────────────────────────────────────────────────────────

export async function listRundownColumns(eventId: string): Promise<RundownColumn[]> {
  const res = await getPool().query<{
    id: string; group_id: string | null; match_location: string | null;
    order_index: number; is_visible: boolean; is_pinned: boolean;
  }>(
    `SELECT id, group_id, match_location, order_index, is_visible, is_pinned
       FROM event_rundown_column WHERE event_id = $1
      ORDER BY order_index, id`,
    [eventId],
  );
  return res.rows.map(r => ({
    id: r.id,
    groupId: r.group_id,
    matchLocation: r.match_location,
    orderIndex: r.order_index,
    isVisible: r.is_visible,
    isPinned: r.is_pinned,
  }));
}

export async function listRundownPlacements(eventId: string): Promise<RundownPlacement[]> {
  const res = await getPool().query<{
    id: string; item_id: string | null; task_id: string | null;
    color: string | null; column_ids: string[] | null;
  }>(
    `SELECT p.id, p.item_id, p.task_id, p.color,
            ARRAY(SELECT pc.column_id FROM event_rundown_placement_column pc
                   WHERE pc.placement_id = p.id) AS column_ids
       FROM event_rundown_placement p
      WHERE p.event_id = $1`,
    [eventId],
  );
  return res.rows.map(r => ({
    entryType: r.item_id ? "item" : "task",
    entryId: (r.item_id ?? r.task_id)!,
    color: r.color,
    pinnedColumnIds: r.column_ids ?? [],
  }));
}

// ─── 写 ───────────────────────────────────────────────────────────────────────

export type RundownColumnInput = {
  groupId?: string | null;
  matchLocation?: string | null;
  isVisible?: boolean;
  isPinned?: boolean;
};

/**
 * 全量覆盖某个 event 的列版面，入参顺序即列顺序。
 *
 * 全量而非增量：前端手里就是一个有序数组，拖动一次会同时改多列的 order_index，
 * 增量接口要么发 N 个请求要么自己算 diff，两样都比重发一次数组更容易错位。
 *
 * 列的身份按 (groupId | matchLocation) 认，不按前端给的 id 认——前端新建的列用的是
 * `custom-<timestamp>` 这种本地 id，认它会让每次保存都变成「删光重建」，条目上钉的
 * 列引用会跟着 CASCADE 掉。所以这里 upsert，只有真正被移除的列才删。
 */
export async function setRundownColumns(
  eventId: string,
  productionId: string,
  columns: RundownColumnInput[],
): Promise<RundownColumn[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const keep: string[] = [];
    for (const [index, col] of columns.entries()) {
      // 两个都给时**报错**而不是偏袒其中一个：静默丢掉一半意图，用户会看到一个
      // 自己没要的列，而且查不出原因
      const groupId = col.groupId ?? null;
      const matchLocation = col.matchLocation?.trim() || null;
      if ((groupId === null) === (matchLocation === null))
        throw new RundownError("bad_column", "每一列要么绑一个用户组，要么给一个地点，二选一");

      if (groupId) {
        const ok = await client.query(
          `SELECT 1 FROM event_group
            WHERE id = $1 AND production_id = $2 AND (event_id IS NULL OR event_id = $3)`,
          [groupId, productionId, eventId],
        );
        if (!ok.rowCount)
          throw new RundownError("bad_column", "包含不可用于本事件的用户组");
      }

      const res = await client.query<{ id: string }>(
        groupId
          ? `INSERT INTO event_rundown_column (event_id, group_id, order_index, is_visible, is_pinned)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (event_id, group_id) WHERE group_id IS NOT NULL
             DO UPDATE SET order_index = EXCLUDED.order_index,
                           is_visible  = EXCLUDED.is_visible,
                           is_pinned   = EXCLUDED.is_pinned
             RETURNING id`
          : `INSERT INTO event_rundown_column (event_id, match_location, order_index, is_visible, is_pinned)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (event_id, match_location) WHERE match_location IS NOT NULL
             DO UPDATE SET order_index = EXCLUDED.order_index,
                           is_visible  = EXCLUDED.is_visible,
                           is_pinned   = EXCLUDED.is_pinned
             RETURNING id`,
        [eventId, groupId ?? matchLocation, index, col.isVisible ?? true, col.isPinned ?? false],
      );
      keep.push(res.rows[0].id);
    }

    await client.query(
      `DELETE FROM event_rundown_column
        WHERE event_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [eventId, keep],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return listRundownColumns(eventId);
}

/**
 * 全量覆盖条目表现（颜色 + 钉列）。
 *
 * 只接受属于本 event 的 item / task，与本 event 的列——跨 event 的 id 会让版面画出
 * 别人家的东西。
 */
export async function setRundownPlacements(
  eventId: string,
  placements: { entryType: "item" | "task"; entryId: string; color?: string | null; pinnedColumnIds?: string[] }[],
): Promise<RundownPlacement[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_rundown_placement WHERE event_id = $1", [eventId]);

    for (const p of placements) {
      const belongs = await client.query(
        p.entryType === "item"
          ? "SELECT 1 FROM event_schedule_item WHERE id = $1 AND event_id = $2"
          : "SELECT 1 FROM task WHERE id = $1 AND event_id = $2",
        [p.entryId, eventId],
      );
      if (!belongs.rowCount)
        throw new RundownError("bad_entry", "包含不属于本事件的条目");

      const row = await client.query<{ id: string }>(
        `INSERT INTO event_rundown_placement (event_id, item_id, task_id, color)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [
          eventId,
          p.entryType === "item" ? p.entryId : null,
          p.entryType === "task" ? p.entryId : null,
          p.color ?? null,
        ],
      );
      const columnIds = [...new Set(p.pinnedColumnIds ?? [])];
      if (columnIds.length) {
        const ok = await client.query(
          "SELECT id FROM event_rundown_column WHERE event_id = $1 AND id = ANY($2::uuid[])",
          [eventId, columnIds],
        );
        if (ok.rowCount !== columnIds.length)
          throw new RundownError("bad_column", "钉列引用了不属于本事件版面的列");
        await client.query(
          `INSERT INTO event_rundown_placement_column (placement_id, column_id)
           SELECT $1, c FROM UNNEST($2::uuid[]) AS c`,
          [row.rows[0].id, columnIds],
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return listRundownPlacements(eventId);
}
