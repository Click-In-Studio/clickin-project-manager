-- 版本退役 Phase B 收尾（PR #300）：清掉 version 概念的数据层化石。
--
-- 前情：版本分叉与「修改过去的版本」两个假设已死——createVersion / rollback /
-- 分支级联 / 版本 UI 全部退役，写路径锁 head（lib/head-version.ts）。本迁移
-- 删除自那以后零读零写的存储残骸：
--
--   · asset_version_rel — 资产文件按版本 pin。resolveAssetFile 已改为一律
--     latest-wins，此表停写停读。「暴力改成 stable」是明确决策：遗留 pin 行
--     不再影响解析（老 VCS 无人使用，pin 的文件即最新文件）。
--   · asset.is_universal — 「版本相关资产」的类型开关。解析不再分叉后恒真，
--     创建路径已停写，UI 徽标与勾选已删。
--   · version.name / description / tags — 版本作为用户概念时代的元数据。
--     唯一写入是 createInitialVersion 硬编码的「初稿」，读取方已清零。
--   · version.status（及 version_status 枚举）— 状态机随分叉概念死亡。六处
--     status 检查已删（前提：线上不存在 active 指向非 editing 版本的演出）。
--
-- 保留（未来「历史记录 / checkpoint」地基，不属化石）：version 表本体、
-- parent_version_id、script_config、marker_structure_revision、
-- scene/character/script/cue_version 四张 per-version 数据表、ref_count CoW。
--
-- 遗留多版本的 version 行本身不删——它们是历史数据，收敛属另案（数据审计）。

BEGIN;

DROP TABLE IF EXISTS asset_version_rel;

ALTER TABLE asset DROP COLUMN IF EXISTS is_universal;

ALTER TABLE version
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS tags,
  DROP COLUMN IF EXISTS status;

DROP TYPE IF EXISTS version_status;

COMMIT;
