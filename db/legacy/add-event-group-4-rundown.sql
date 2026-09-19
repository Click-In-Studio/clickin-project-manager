-- 【用户组序列 4/4】rundown 的版面：列配置与条目表现。依赖 1/4（event_group）。
--
-- ## 为什么不能靠 event_group 本身当列
--
-- 组是**跨 event 共享**的（B 型是项目级常驻编制）。「进场对光小组在上海站排第 2 列、
-- 在北京站排第 5 列、在广州站根本不出现」——这三件事只能记在 (event, group) 这一层，
-- 记在组上会互相覆盖。此前 event_group.order_index 就是这个毛病。
--
-- 顺带解掉另外三件：
--   · 列的显示/隐藏（organizer 说这次不看服化那一列）
--   · 粘性列（横向滚动时钉在左边）。**注意这与冻结快照毫无关系**，前端原来叫
--     `frozen`，撞名危险，这里一律叫 pinned。
--   · 空列——先建列再往里拖东西。靠「被引用才成为列」推导是建不出空列的。
--
-- ## 地点列
--
-- 地点是**事项的属性**（event_schedule_item.location），不是组的属性——一个组的人
-- 9 点在主剧场、14 点在 A3。所以「地点列」不是存了个地点，是一条**筛选条件**：
-- 这一列收所有 location 匹配的事项，完全不看人。故 match_location 与 group_id 二选一。
--
-- ## 条目表现为什么用两个可空 FK 而不是 (entry_type, entry_id)
--
-- 前端的 entryKey 是 `item:<id>` / `task:<id>` 这种多态串。落库时拆成两个可空 FK，
-- 换来两样东西：外键完整性，以及事项/任务被删时表现行自动清掉——多态列做不到，
-- 只会攒下一堆指向不存在 id 的孤儿行。

BEGIN;

CREATE TABLE IF NOT EXISTS event_rundown_column (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       TEXT    NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  -- 二选一：按人（绑一个用户组）或按地点（匹配 event_schedule_item.location）
  group_id       UUID    REFERENCES event_group(id) ON DELETE CASCADE,
  match_location TEXT,
  order_index    INTEGER NOT NULL DEFAULT 0,
  is_visible     BOOLEAN NOT NULL DEFAULT true,
  -- 横向滚动时钉在左侧。与 event_group_freeze 的「冻结」无关，勿混
  is_pinned      BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT event_rundown_column_kind CHECK (num_nonnulls(group_id, match_location) = 1)
);

-- 同一个组 / 同一个地点在一个 event 的版面里只能占一列
CREATE UNIQUE INDEX IF NOT EXISTS event_rundown_column_group_idx
  ON event_rundown_column (event_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS event_rundown_column_location_idx
  ON event_rundown_column (event_id, match_location) WHERE match_location IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_rundown_column_event_idx ON event_rundown_column (event_id);

-- 单个条目在版面上的表现：颜色 + 被钉到哪几列
CREATE TABLE IF NOT EXISTS event_rundown_placement (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   TEXT NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  item_id    TEXT REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES task(id) ON DELETE CASCADE,
  color      TEXT,
  CONSTRAINT event_rundown_placement_entry CHECK (num_nonnulls(item_id, task_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_rundown_placement_item_idx
  ON event_rundown_placement (event_id, item_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS event_rundown_placement_task_idx
  ON event_rundown_placement (event_id, task_id) WHERE task_id IS NOT NULL;

-- 手动钉列（entryLaneOverrides）。走关联表而不是 UUID[]：数组挂不了外键，
-- 列被删之后会留下指向不存在 id 的脏值，而这种脏值不会报错、只会让格子悄悄画错位。
CREATE TABLE IF NOT EXISTS event_rundown_placement_column (
  placement_id UUID NOT NULL REFERENCES event_rundown_placement(id)  ON DELETE CASCADE,
  column_id    UUID NOT NULL REFERENCES event_rundown_column(id)     ON DELETE CASCADE,
  PRIMARY KEY (placement_id, column_id)
);

COMMIT;
