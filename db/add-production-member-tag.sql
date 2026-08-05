-- Phase 2 (#165): 成员标签系统
-- production_id IS NULL = 系统预设标签（跨演出共享）；非 NULL = 该演出自定义标签。

CREATE TABLE IF NOT EXISTS production_member_tag (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT REFERENCES production(id) ON DELETE CASCADE NULL,
  name          TEXT NOT NULL,
  is_system     BOOLEAN NOT NULL DEFAULT false
);

-- 系统预设标签：name 全局唯一（production_id IS NULL）
CREATE UNIQUE INDEX IF NOT EXISTS pmt_system_name_idx
  ON production_member_tag (name) WHERE production_id IS NULL;

-- 演出自定义标签：同一演出内 name 唯一
CREATE UNIQUE INDEX IF NOT EXISTS pmt_prod_name_idx
  ON production_member_tag (production_id, name) WHERE production_id IS NOT NULL;

-- 系统预设 seed（PRD D4: 正式/副/助理/实习/顾问/外包）
INSERT INTO production_member_tag (name, is_system)
VALUES ('正式', true), ('副', true), ('助理', true), ('实习', true), ('顾问', true), ('外包', true)
ON CONFLICT (name) WHERE production_id IS NULL DO NOTHING;

-- 成员-标签关联表（替代 production_member.tags TEXT[]）
CREATE TABLE IF NOT EXISTS production_member_tag_assignment (
  production_id TEXT NOT NULL REFERENCES production(id)             ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id)               ON DELETE CASCADE,
  tag_id        UUID NOT NULL REFERENCES production_member_tag(id)  ON DELETE CASCADE,
  PRIMARY KEY (production_id, user_id, tag_id)
);

CREATE INDEX IF NOT EXISTS pmta_user_prod_idx
  ON production_member_tag_assignment (production_id, user_id);
