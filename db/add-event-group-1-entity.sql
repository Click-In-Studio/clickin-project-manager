-- 【用户组序列 1/4】实体本身。2/4（task 责任主体）有 FK 指向本文件建的 event_group，
-- 必须先跑。文件名带序号是因为字母序里 `add-event-group-3-freeze` 会排到
-- `add-event-group.sql` 前面（'-' < '.'），靠原名排序会把依赖序排反。
-- 用户组（event_group）：由若干「部门」与「人」组成的集合，自带 POC。
--
-- 存在的理由：rundown 要能把「灯光部 + 一个助理舞监 + 几个外场 runner」当成
-- 「进场对光小组」这一个实体来排。原来 event 只能直挂 部门 / 人两种，画不出这种
-- 临时编组，前端只好把列配置塞进 localStorage——那等于「我的 rundown 不是你的
-- rundown」，而 rundown 本来就是 organizer 定好大家遵守的东西。
--
-- 两型（type 由 event_id 是否为 NULL 判定，不另设列——列会和它漂）：
--   A 型  event_id 非空：该 event 专属的临时编组。门 = 该 event 的内容编辑权
--                        （hasEventContentEdit），任意 organizer 可自行安排。
--   B 型  event_id 为空：项目级常驻编制。门 = node:user_group/* 那组键，且因为
--                        它的 POC 会在**所有**引用它的 event 里生效，设 POC 单独
--                        一枚 poc@edit，不与 @edit 合并。
--
-- POC 是责任单点（dept 或 user 二选一，见 CHECK），这是「指派归 POC」（2026-08-15
-- 定谳）的前提——集合式责任主体会让「谁是 POC」没有唯一答案。dept 型 POC 的语义是
-- 「该部门的现任 POC 即本组 POC」，随部门 POC 变更自动跟踪（Type B，不落行）。

BEGIN;

CREATE TABLE IF NOT EXISTS event_group (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  -- NULL = B 型（项目级常驻编制）；非 NULL = A 型（该 event 专属）
  event_id      TEXT        REFERENCES production_event(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  -- 刻意没有 location：组回答「谁」，不回答「哪儿」。地点是事项的属性
  -- （event_schedule_item.location），一个组的人 9 点在主剧场、14 点在 A3，
  -- 组上存一份地点答不出这个，还会和事项那份打架。
  color         TEXT,
  order_index   INTEGER     NOT NULL DEFAULT 0,
  -- POC 二选一。应用层还要求它必须是本组成员（「以其中的一个部门/人为 POC」），
  -- 那条约束跨表，留在 lib/event-group-db.ts 的事务里保证。
  poc_dept_id   UUID        REFERENCES production_dept(id) ON DELETE SET NULL,
  poc_user_id   UUID        REFERENCES app_user(id)        ON DELETE SET NULL,
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_group_poc_single CHECK (num_nonnulls(poc_dept_id, poc_user_id) <= 1)
);

-- 同一作用域内组名唯一。COALESCE 而非两个 partial index：A 型与 B 型可以重名
-- （项目级「技术组」与某 event 的「技术组」是两个东西），同作用域内不行。
CREATE UNIQUE INDEX IF NOT EXISTS event_group_name_unique_idx
  ON event_group (production_id, COALESCE(event_id, ''), name);

CREATE INDEX IF NOT EXISTS event_group_production_idx ON event_group (production_id);
CREATE INDEX IF NOT EXISTS event_group_event_idx      ON event_group (event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_group_member (
  group_id UUID        NOT NULL REFERENCES event_group(id)     ON DELETE CASCADE,
  dept_id  UUID        REFERENCES production_dept(id)          ON DELETE CASCADE,
  user_id  UUID        REFERENCES app_user(id)                 ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 成员要么是一个部门要么是一个人，不能既是又是、也不能都不是
  CONSTRAINT event_group_member_one_kind CHECK (num_nonnulls(dept_id, user_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_group_member_dept_idx
  ON event_group_member (group_id, dept_id) WHERE dept_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS event_group_member_user_idx
  ON event_group_member (group_id, user_id) WHERE user_id IS NOT NULL;

-- 组挂到流程项上。与 schedule_item_participant / schedule_item_department **并联**，
-- 不是串联——直挂人/部门的老路保留，组是可选的聚合层。这样零数据迁移，且「临时
-- 加一个人」不必先建组。
CREATE TABLE IF NOT EXISTS schedule_item_group (
  item_id  TEXT NOT NULL REFERENCES event_schedule_item(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES event_group(id)         ON DELETE CASCADE,
  PRIMARY KEY (item_id, group_id)
);

CREATE INDEX IF NOT EXISTS schedule_item_group_group_idx ON schedule_item_group (group_id);

COMMIT;
