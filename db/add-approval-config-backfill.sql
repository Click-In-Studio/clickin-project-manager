-- production_approval_config 存量回填。
--
-- 该表是 Phase 3（#163）才加的，建表 SQL 只 CREATE TABLE、没有回填，早于它的
-- 演出一行都没有。createProduction 从那以后才开始插行，所以线上 8 个演出全部
-- 缺行 —— 而 escalateExpiredApprovals 原先 INNER JOIN 这张表，缺行即永不匹配，
-- 整条超时升级链自 Phase 7 起从未生效过（cron 挂没挂都一样）。
--
-- 读路径已改为 LEFT JOIN + COALESCE(ttl_hours, 24)，缺行也能按默认值计时；
-- 这里把行补齐，好让制作人在 UI 上看得到、改得动这个配置。
-- updated_by 留 NULL = 从未被人工修改（与建表注释一致）。
-- 下面的 24 与 lib/db.ts 的 DEFAULT_APPROVAL_TTL_HOURS 是同一个默认值，改要同改
-- （两处都对齐 production_approval_config.ttl_hours 的列 DEFAULT）。

INSERT INTO production_approval_config (production_id, ttl_hours)
SELECT p.id, 24
FROM production p
WHERE NOT EXISTS (
  SELECT 1 FROM production_approval_config pac WHERE pac.production_id = p.id
);
