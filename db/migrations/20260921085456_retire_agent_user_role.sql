-- migrate:up
-- #603：退役 agent_user 角色。它是 OpenClaw 时代 click_in_agent 库的应用用户，
-- 网关 / 插件 2026-08-29 已全部下线（#367），但主库 26 张表上的 DML 授权与
-- click_in_agent 的库级授权还挂在它名下。
--
-- DROP OWNED 一次回收当前库里全部对象权限 + 共享对象（database ACL）上的权限，
-- 比逐类 REVOKE 稳。角色不进 schema 指纹，schema.sql 不动。
--
-- 两层保护：
--   · IF EXISTS：CI / 本机空库从没建过这个角色（且 CI 以 script_editor 跑，没有
--     CREATEROLE），裸 REVOKE / DROP 会直接报错；线上 CD 以 postgres 跑，能删。
--   · DROP ROLE 捕获依赖错误：agent_user 在 click_in_agent 库内四张表上还有表级
--     ACL，本支跑在 script_editor 里够不着另一个库。这种情况下主库授权已回收，
--     角色留待人在服务器上 DROP DATABASE click_in_agent + DROP ROLE 收尾
--     （docs/DEPLOY.md「退役 Agent 库」），不让整支 migration 因此失败。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_user') THEN
    DROP OWNED BY agent_user;
    BEGIN
      DROP ROLE agent_user;
    EXCEPTION WHEN dependent_objects_still_exist THEN
      RAISE WARNING '#603: agent_user 在其他库仍有依赖（%），主库授权已回收；请在服务器上手动 DROP DATABASE click_in_agent 后 DROP ROLE agent_user', SQLERRM;
    END;
  END IF;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'irreversible'; END $$;
