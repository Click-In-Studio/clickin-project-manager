-- 【用户组序列 3/3】冻结快照。刻意不对 event_group 挂 FK（见下），所以理论上与
-- 1/3 无 DDL 依赖；仍排在最后，因为读写它的代码依赖前两个。
-- 用户组的冻结快照。
--
-- ## 冻的是什么
--
-- **「event × group 的成员解析结果」，不是 group 本身。** 一个项目级（B 型）组可能
-- 被 5 个 event 引用，其中 3 个过了 deadline 冻了、2 个还活着——组本身照常改，改动
-- 只影响那 2 个。所以键是 (event_id, group_id, frozen_at) 而不是 group_id。
--
-- ## 为什么必须有 deadline
--
-- 「event 都结束一年了，只要 organizer 忘了点人就一直在变」是不合理的：组是活引用
-- （部门加人自动进组），不冻的话一年后的人员变动会回头改写去年那场演出的参与名单。
-- deadline 取 event.end_time + 宽限期，由 cron 真物化——**不能做成派生谓词**懒惰计算，
-- 否则 deadline 到首次读取之间的部门人员变动会污染快照，冻出来的是「碰巧有人打开
-- 页面那一刻」的名单，一年没人看的 event 反而冻出一年后的名单。
--
-- ## 为什么是完整快照
--
-- 用户定的两条功能决定了每一列：
--   追责与审计 —— 追得到当时的人，也追得到他当时**以什么身份**在组里（via_dept_*），
--                 以及当时的 POC 是谁（poc_user_*）
--   善后与处理 —— 那个人可能早就离职了，但部门还在，顺着 via_dept_id / poc_dept_id
--                 找现任。**系统只保存关系，不替人决定找谁**——判定端没有「POC 失效
--                 → 自动落到某部门现任 POC」这种回退链，那是 PSM 的判断。
--
-- POC 部门型必须同时记「部门」和「当时该部门的实际 POC 那个人」：只记部门则追责追到
-- 的是现任而非当时那位；只记人则善后断链。两个都记，两条功能才同时成立。
--
-- ## 为什么所有 *_name 都是文本冗余
--
-- 审计要的是「当时叫什么」，不能随实体改名而漂。仓库已有同款先例：
-- task_assignee.name、schedule_item_participant.name。
--
-- ## refreeze 追加不覆盖
--
-- unfreeze 置 released_at，refreeze 插新一版。读取取最新一条 released_at IS NULL。
-- 覆盖式 UPDATE 会让「某人以灯光部在进场对光小组参加上海站进场」这条事实在改一次
-- 名单后消失——而那正是冻结要保住的东西。

BEGIN;

-- 组级：一次冻结一行
CREATE TABLE IF NOT EXISTS event_group_freeze (
  event_id      TEXT        NOT NULL REFERENCES production_event(id) ON DELETE CASCADE,
  -- **刻意不设 FK。** 快照自带 group_name / poc_*_name，组行删掉之后依然解析得出；
  -- 解散守卫只挡**未冻结**的引用（见 lib/event-group-db.ts 的 deleteEventGroup），
  -- 也就是说全部引用都冻结之后组是可以删的。若挂 FK：CASCADE 会把审计一起删掉，
  -- SET NULL 与 PK 的 NOT NULL 冲突——两条都不可接受，所以这里存的是「当时那个组的
  -- id」这一事实，不是一条活引用。
  group_id      UUID        NOT NULL,
  frozen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at   TIMESTAMPTZ,
  group_name    TEXT        NOT NULL,
  location      TEXT        NOT NULL DEFAULT '',
  poc_dept_id   UUID        REFERENCES production_dept(id) ON DELETE SET NULL,
  poc_dept_name TEXT,
  poc_user_id   UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  poc_user_name TEXT,
  frozen_by     UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  PRIMARY KEY (event_id, group_id, frozen_at)
);

-- 同一 (event, group) 至多一版处于生效状态；refreeze 前必须先 release
CREATE UNIQUE INDEX IF NOT EXISTS event_group_freeze_active_idx
  ON event_group_freeze (event_id, group_id) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS event_group_freeze_event_idx ON event_group_freeze (event_id);

-- 成员级：人 + 他当时是通过哪条路进的组
-- 代理键：自然键里的 user_id / via_dept_id 都会被 ON DELETE SET NULL 打空，
-- 而 PK 列不能为空。同一个人既是直接成员又在某个成员部门里时**留两行**——
-- 「他以什么身份在场」是两条独立的事实，审计要都看得见。
CREATE TABLE IF NOT EXISTS event_group_freeze_member (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      TEXT        NOT NULL,
  group_id      UUID        NOT NULL,
  frozen_at     TIMESTAMPTZ NOT NULL,
  user_id       UUID        REFERENCES app_user(id) ON DELETE SET NULL,
  user_name     TEXT        NOT NULL,
  -- NULL = 直接个人成员，不是被某个部门带进来的
  via_dept_id   UUID        REFERENCES production_dept(id) ON DELETE SET NULL,
  via_dept_name TEXT,
  FOREIGN KEY (event_id, group_id, frozen_at)
    REFERENCES event_group_freeze (event_id, group_id, frozen_at) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS event_group_freeze_member_snapshot_idx
  ON event_group_freeze_member (event_id, group_id, frozen_at);

CREATE INDEX IF NOT EXISTS event_group_freeze_member_user_idx
  ON event_group_freeze_member (user_id) WHERE user_id IS NOT NULL;

COMMIT;
