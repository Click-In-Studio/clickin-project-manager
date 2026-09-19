-- production.owner_id 补 NOT NULL（2026-08-18）
--
-- 为什么现在补：owner 是「责任转移守恒」链条的终点（MindWeave《权限系统-不变量与策略
-- 汇总》M-14(c)）——非旁路的 grants@edit 持有者可以丢（撤部门 / 撤 POC / 清退成员），
-- 责任逐级转移到制作人、再到 owner；而 owner 恒在，递归才终止、权限才不会真正流失。
-- 「owner 恒在」此前只靠代码纪律撑着：建演出必设、无置空路径、FK 无 ON DELETE 故删账号
-- 被 RESTRICT 挡住——承重却无人看守。本文件把它交给 schema。
--
-- 历史遗留的无主演出来自 POST /api/admin/import-feishu：该路由建演出时不传 owner
-- （且此前完全不鉴权），同批已修。生产库的身份迁移已完成，线上应为零 NULL 行。
--
-- 幂等：已是 NOT NULL 时整段跳过，可重复执行。
-- 若仍有 NULL 行，ALTER 会失败并中断部署——这是有意的：无法自动定主的演出必须人工
-- 处置（owner 是 ROOT 级权柄，不允许脚本随便指派）。排查用：
--   SELECT id, name, created_at FROM production WHERE owner_id IS NULL ORDER BY created_at;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'production'
      AND column_name = 'owner_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE production ALTER COLUMN owner_id SET NOT NULL;
  END IF;
END
$$;
