-- task 的时间归属从 milestone（点）换轨到 phase（区间，add-phase.sql）：
-- task_milestone 边表退役。定案时线上 task_milestone / milestone 均为 0 行，
-- 无数据可迁——纯删表。milestone 实体表保留（与 phase 平级的时间节点概念）。
--
-- 依赖顺序：add-phase.sql 先行（同 PR，按文件首次 commit 顺序应用）。

DROP TABLE IF EXISTS task_milestone;
