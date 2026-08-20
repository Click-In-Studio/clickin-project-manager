-- 物料台账：道具 / 服装 / 设备 / 布景的实体清单。
--
-- 与 asset 表的区别（容易混，先写清楚）：`asset` 是**数字资产**——文件、R2 对象、
-- 飞书链接，回答「设计稿在哪个链接」。本表是**实体物**——「PR-014 旧式黄铜航海罗盘，
-- 库位 A-03，道具组负责，已入库」。两者以后大概率要互相引用（道具的照片），但不是
-- 一张表。
--
-- ## 状态只做列表，不做状态机（2026-08-20 用户定谳）
--
-- 「已入库 / 制作中 / 使用中 / 待修整」现在没有任何流转约束——任何状态可以改到任何
-- 状态。理由不是省事：状态机一旦定死再改是**破坏性**的（存量数据可能违反新规则，
-- 要么迁移要么放行例外），而「先无约束、后加约束」只需要一次数据校验。等真实用法
-- 跑出规则了再加，不亏。
--
-- 状态列表本身可配置，照 production_member_tag 的成熟范式：production_id 为 NULL
-- 的是系统预设（全库共用），非 NULL 的是某个剧组自己加的。
--
-- ## 责任方复用 task 的口径
--
-- 部门 | 用户组，二选一（见 lib/task-poc.ts 的 TaskSubject）。组自带 POC，所以
-- 「这批道具归谁负责」和「这条任务归谁负责」是同一套解析，不另造一套。

BEGIN;

-- ── 状态定义 ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_material_status (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = 系统预设（全库共用）；非 NULL = 该剧组自定义
  production_id TEXT    REFERENCES production(id) ON DELETE CASCADE NULL,
  name          TEXT    NOT NULL,
  /** 台账里的色块。留空则前端按默认色渲染。 */
  color         TEXT,
  order_index   INTEGER NOT NULL DEFAULT 0,
  is_system     BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS pms_system_name_idx
  ON production_material_status (name) WHERE production_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pms_prod_name_idx
  ON production_material_status (production_id, name) WHERE production_id IS NOT NULL;

INSERT INTO production_material_status (production_id, name, color, order_index, is_system) VALUES
  (NULL, '已入库', '#3f6b48', 1, true),
  (NULL, '制作中', '#b45309', 2, true),
  (NULL, '使用中', '#315f66', 3, true),
  (NULL, '待修整', '#8c4654', 4, true),
  (NULL, '已报废', '#6b7280', 5, true)
ON CONFLICT (name) WHERE production_id IS NULL DO NOTHING;

-- ── 台账 ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_material (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT        NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  /** 剧组自己的编号（PR-014 / CS-021）。同一剧组内唯一，跨剧组不管。 */
  code          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  /** 道具 / 服装 / 设备 / 布景。刻意留自由文本：分类比状态稳定得多，先不建实体；
   *  真要收敛成一等实体时，现有取值就是迁移数据。 */
  category      TEXT        NOT NULL DEFAULT '',
  -- 责任方：部门 | 用户组，二选一（同 task，见 lib/task-poc.ts）
  department_id UUID        REFERENCES production_dept(id) ON DELETE SET NULL,
  group_id      UUID        REFERENCES event_group(id)     ON DELETE SET NULL,
  -- ON DELETE SET NULL：状态定义被删掉不该连坐删台账行，落成「未标状态」
  status_id     UUID        REFERENCES production_material_status(id) ON DELETE SET NULL,
  location      TEXT        NOT NULL DEFAULT '',
  quantity      INTEGER     NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  notes         TEXT        NOT NULL DEFAULT '',
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT material_owner_single CHECK (num_nonnulls(department_id, group_id) <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS production_material_code_idx
  ON production_material (production_id, code);
CREATE INDEX IF NOT EXISTS production_material_production_idx
  ON production_material (production_id);
CREATE INDEX IF NOT EXISTS production_material_status_idx
  ON production_material (status_id) WHERE status_id IS NOT NULL;

COMMIT;
