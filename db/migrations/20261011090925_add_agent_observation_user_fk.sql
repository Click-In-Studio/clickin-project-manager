-- migrate:up
-- 记忆块删除保留性能观测；账号删除则遵循用户数据的清理生命周期。
ALTER TABLE agent_observation ADD CONSTRAINT agent_observation_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;

-- migrate:down
ALTER TABLE agent_observation DROP CONSTRAINT agent_observation_user_id_fkey;
