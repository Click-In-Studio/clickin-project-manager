-- 新环境一次性引导：应用角色与默认权限。以 postgres 超级用户执行，建库之前或之后皆可。
--
--   sudo -u postgres psql -v app_password='...' -f db/bootstrap-roles.sql
--
-- 为什么单独一份而不写进 schema.sql：
--   · schema.sql / migrations 只描述**结构**，由 postgres 用户执行，表 owner 全是
--     postgres；应用用户 script_editor 只拿 DML（这也是「应用代码禁 DDL」的物理保证，
--     见 DEV_GUIDE §6）。
--   · 结构指纹（db/fingerprint.sql）刻意不含 GRANT / owner，本文件不影响指纹。
--   · 线上靠的是 ALTER DEFAULT PRIVILEGES：以后 migration 新建的表自动带授权，
--     不用每张表再 GRANT 一次。没有这一步，新表上线即 42501 permission denied。
--
-- 幂等：可重复执行。

\set ON_ERROR_STOP on

-- psql 变量在 DO $$ 块（dollar-quoted）里不做替换，所以用 SELECT … \gexec 的写法。
SELECT format('CREATE ROLE script_editor LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'script_editor') \gexec

-- 建库（已存在则跳过）；owner 留 postgres。
SELECT 'CREATE DATABASE script_editor'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'script_editor') \gexec

\connect script_editor

GRANT USAGE ON SCHEMA public TO script_editor;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO script_editor;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO script_editor;

-- 以后由 postgres 建的表 / 序列自动授权（与线上 pg_default_acl 现状一致）
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO script_editor;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO script_editor;
