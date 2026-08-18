-- task 失去宿主事件的标记（#236 形状 L，2026-08-18）
--
-- policy.orphan_task_disposition 的「保留为孤儿并标记待处理」档需要一个落点：
-- 任务失去最后一个宿主 event 后仍留着，但要能在任务列表里被认出来、由部门 POC
-- 决定是删还是转挂到别的事件。
--
-- 为什么不复用 status：status 是**工作进度**（awaiting/pending/…），孤儿是
-- **结构状态**（有没有宿主），两者正交——一个已完成的任务照样可能变孤儿。挤进
-- 同一列会让「已完成 ∧ 失去锚点」这种组合表达不出来。
--
-- 语义：NULL = 有宿主或从未失去过；非 NULL = 失去宿主的时刻。重新绑定事件时清空。
ALTER TABLE task ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS task_orphaned_idx ON task(production_id) WHERE orphaned_at IS NOT NULL;
