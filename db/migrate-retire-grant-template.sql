-- grant_template 退役（#163 项目模版收编）。
--
-- 这张表是 bootstrap：运行时零读取，只在建演出 / 建角色时 seed 进
-- production_role_permission。项目模版接手了同一份职责，且**必须**接手——
-- 那张表的取数（templateKeysForRole）是并集，per-type 行只能加不能减：
--
--   · 同名岗位不同等级——「作曲」在音乐剧与在音乐专辑是两套权限，不是包含关系
--   · 基线本身要分叉——影视类要求 script / cue 非必要不授予，得**削**基线
--
-- 两件事都是减法，表结构表达不了。内容已逐键搬进 lib/templates/theatre.ts，
-- 等价性由 tests/grant-template-retire.migration.test.ts 的 invariance 层机器验证。
--
-- 两条有意不搬的行：副导演 / 助理舞台监督——migrate-assistant-roles.sql 已把复合
-- 职位拆成 base role + tag，这两个名字不在任何模版的角色名单里，其模板行是死键。
--
-- 已 seed 进各演出 production_role_permission 的行**不受影响**：本迁移只删模板源。

BEGIN;

DROP TABLE IF EXISTS grant_template;

COMMIT;
