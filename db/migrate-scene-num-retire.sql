-- scene 数据架构过渡态收尾（#159）：删掉 scene_version.num。
--
-- 前情：场次/章节已全量 marker 化——marker block 是唯一真相源，scene_version
-- 退化为「由 marker 派生、在同一事务内重建」的读模型
-- （lib/db.ts::syncSceneVersionsFromMarkersInTx）。场次号自那以后一律由
-- buildMarkerLabelIndex 按 marker 层级实时生成（「第一幕」/「1-2」），num 列
-- 变成纯粹的只写死列：
--
--   · 唯一写入方是 flushToDBVersioned 的 markerBacked 分叉——版本里存在任何
--     marker 时写空串，否则写导入表格里的原始场次号。存量版本已全部
--     marker 化（commit 2110bb1 删运行时迁移时人工 SQL 核验过），该分叉的
--     「否则」一侧从此不可达。
--   · 读取方为零：全库无一处 SELECT num / ORDER BY num。UI、搜索、agent SQL
--     取的都是 marker 派生的 number 字段。
--
-- 存量遗留的非空 num 值不做迁移——它们是 marker 化之前的历史快照，与当前
-- marker 生成的场次号可能不一致，保留反而会误导。真正的场次号在 marker
-- 层级里，删列不丢信息。
--
-- 保留：scene_version 表本体及其余各列。它是有真实读者的派生读模型
-- （全局搜索 lib/search-db.ts、权限资源名 lib/resource-directory.ts、
-- agent 剧本 SQL agent/db-script.ts），不属化石，不要顺手删表。

BEGIN;

ALTER TABLE scene_version DROP COLUMN IF EXISTS num;

COMMIT;
