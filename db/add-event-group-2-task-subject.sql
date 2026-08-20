-- 【用户组序列 2/4】task.group_id → event_group 的 FK。依赖 1/4。
-- task 的责任主体从「部门」泛化为「部门 | 用户组」。
--
-- 为什么要这个：「进场对光」这件事的责任方是「进场对光小组」（灯光部 + 一个助理
-- 舞监 + 几个外场 runner），不是灯光部——把它挂给灯光部，那个助理舞监和 runner 就
-- 从责任链里消失了。用户原话：「在这一个 task 里面他们确实是绑定的一个实体」。
--
-- 二选一，不是并存（CHECK）。POC 必须是责任单点，否则「指派归 POC」（2026-08-15
-- 定谳）没有唯一答案。组自带 POC（见 event_group），所以绑组之后 POC 仍然唯一——
-- 这正是「组是实体而非规则」这个决定换来的东西。
--
-- ON DELETE SET NULL 与 department_id 同款：责任主体消失 = task 失去责任方，
-- 与部门被解散时的处理一致，不连坐删 task。

BEGIN;

ALTER TABLE task
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES event_group(id) ON DELETE SET NULL;

-- 已有行 group_id 恒为 NULL，约束天然满足
ALTER TABLE task
  DROP CONSTRAINT IF EXISTS task_subject_single;
ALTER TABLE task
  ADD CONSTRAINT task_subject_single
  CHECK (num_nonnulls(department_id, group_id) <= 1);

CREATE INDEX IF NOT EXISTS task_group_idx ON task (group_id) WHERE group_id IS NOT NULL;

COMMIT;
