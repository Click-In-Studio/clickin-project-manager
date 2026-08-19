-- production_dept_permission.source：这一行由谁在管（#274）。
--
-- 背景：这张表里混着五个写点的产物——项目模版的静态区间行、管理面手工配的、cue 声明行
-- 实例化的、建 cue 表定式发的、以及分享面/事件归属信号发的。前两类是人在管（该在权限
-- 中心里编辑），后三类是别处在管（在这儿删只会被下次传播补回来）。
--
-- 为什么必须记而不能推：**键形推不出来**。人有权手动给某部门发某张 cue 表、某个事件的
-- 实例键（权限键选择器的 id 位下拉就是为此存在的，见 resource-directory 端点），所以
-- 「具体实例 id ⇒ 自动行」是错的。而读时反查 owning 表（声明表 + 归属信号表）虽然不会
-- 与现实脱节，却要求**每加一条自动通道都有人记得回来补一条 join**——policy 扩展会批量
-- 生产新通道，那条路是在埋坑。故写点自报家门。
--
-- 词汇（闭集，按「要改它得去哪儿」划分，不是按「谁创建的」）：
--   manual   人在权限中心配的 / 项目模版灌的静态区间行 —— 就在这儿改
--   template cue 声明行实例化（dept_cue_list_template）—— 去权限模版页改声明
--   resource 资源自身的归属或分享面（建表定式 / cue 表分享 / 事件归属部门）—— 去该资源页改
--
-- ⚠ **同一枚键只有一行**（UNIQUE (dept_id, permission_key)）：人手动发的与自动发的若
-- 撞上，库里就是同一行，故 source 记的是「谁在管」而非「谁创建的」。自动通道用
-- DO UPDATE 升级（manual → template/resource），因为撤声明 / 撤分享时那一行本来就会被
-- 按键形收走（removeCueTemplateGrants / removeCueListDeptAccess），标成 manual 只会让
-- 界面撒谎说「可以在这儿改」。
--
-- 回填：既有行按现有 owning 表反推一次（这是 B 方案的逻辑，只跑这一次，此后靠写点维持）。
-- 幂等，可重复执行。

BEGIN;

ALTER TABLE production_dept_permission
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

DO $$ BEGIN
  ALTER TABLE production_dept_permission
    ADD CONSTRAINT production_dept_permission_source_check
    CHECK (source IN ('manual', 'template', 'resource'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 回填 1：cue 声明行实例化的 → template ────────────────────────────────────
-- 判据：该 dept 对该 cue 表所属模版有声明行，且键指向那张表的实例。
UPDATE production_dept_permission pdp
SET source = 'template'
WHERE pdp.source = 'manual'
  AND EXISTS (
    SELECT 1
    FROM cue_list cl
    JOIN dept_cue_list_template t
      ON t.dept_id = pdp.dept_id AND t.template = cl.template
    WHERE cl.production_id = pdp.production_id
      AND pdp.permission_key LIKE 'node:cue_list/' || cl.id || '%'
  );

-- ── 回填 2：资源归属 / 分享面发的 → resource ──────────────────────────────────
-- 判据：resource_dept_manage 里有该 (dept, 类型, 实例) 的归属信号，且键指向该实例。
UPDATE production_dept_permission pdp
SET source = 'resource'
WHERE pdp.source = 'manual'
  AND EXISTS (
    SELECT 1 FROM resource_dept_manage rdm
    WHERE rdm.dept_id = pdp.dept_id
      AND rdm.production_id = pdp.production_id
      AND rdm.resource_id <> '*'
      AND pdp.permission_key LIKE 'node:' || rdm.resource_type || '/' || rdm.resource_id || '%'
  );

COMMIT;
