-- 注册邀请制（测试期收口「登录即注册」，防无邀请的 0 级账号）
--
-- 语义：
--   · 开关是环境变量 REGISTRATION_INVITE_ONLY（测试期开、正式开放关，不动库）。
--   · 开启时，email 通道创建新账号需注册正当性四选一（老用户登录不受任何影响）：
--       1. registration_code 注册邀请码（通用机制——将来飞书机器人上架脱离组织
--          限定后，飞书通道的新账号门也复用这套码）
--       2. registration_email 指定邮箱登记表
--       3. 邮箱命中未失效的定向项目邀请（production_invite.email——被邀请进项目
--          的人本身就是「指定邮箱」）
--       4. 从有效邀请链接落地（/invite/<token> 透传，开放/认领链接的受邀者不需要
--          额外要码）
--   · 两张登记表都没有创建界面：管理员手工 INSERT（与 plan_code 同纪律）。
--   · 飞书通道暂不设门：租户应用天然限定组织成员，本身就是邀请制。

CREATE TABLE IF NOT EXISTS registration_code (
  code       TEXT        PRIMARY KEY,
  max_uses   INTEGER     NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER     NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NULL,
  note       TEXT        NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 兑换流水：码在创建账号的同一事务内消耗（typo 邮箱不白烧——码只在真正建号时扣）。
CREATE TABLE IF NOT EXISTS registration_code_redemption (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT        NOT NULL REFERENCES registration_code(code) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_code_redemption_code_idx
  ON registration_code_redemption (code);

-- 指定邮箱登记表：登记即可注册，不必先邀请进任何项目。
CREATE TABLE IF NOT EXISTS registration_email (
  email      TEXT        PRIMARY KEY,  -- 存小写
  note       TEXT        NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
