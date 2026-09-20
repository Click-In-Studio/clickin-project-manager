-- ═══════════════════════════════════════════════════════════════════════════
-- Task 独立化迁移：event_tech_req → task（脱离 event 强绑定）
--
-- 背景：task（原"技术需求"）挂死在 event 下——event_id NOT NULL CASCADE、
-- production 归属靠 join event 推导、自身无起止时间。权限词汇（resource_type）
-- 已于批B 更名 'task'，前端路由已是 /tasks，仅剩表名与表结构是旧世界。
--
-- 终局（用户 2026-08-14 拍板）：
--   1. 表改名 event_tech_req → task（连带 event_tech_req_item → task_schedule_item、
--      event_tech_assignee → task_assignee，req_id 列 → task_id）
--   2. production_id 落列（从 event 回填）；event_id 可空，event 删除 SET NULL
--      （task 独立存活，production 删除仍 CASCADE 兜底）
--   3. 自身 start_time/end_time（可空）；有效时间解析链：自身 → 绑定 schedule
--      items 的 min/max → event 起止（读侧计算，不落库）
--   4. 新表 task_milestone（0..n 里程碑，不约束截止先后）、task_dependency
--      （GitHub 式 blocking 边，纯信息性，不进状态机；写入侧应用层禁环）
--      ——因 CI/deploy 同 commit 内 add-* 先于 migrate-* 执行，而两表 FK 引用
--      改名后的 task，故随本文件建表，不走 add-*.sql。
--
-- 同批清理死账：
--   - task.schedule_item_id 死列（绑定早已走 event_tech_req_item 多对多）
--   - resource_dept_manage 中 resource_type='tech_req' 死行（writeTechReqGrants
--     的 event 管理部门继承曾误写旧词汇，判定侧只读 'task'）
--   - asset_mount.mount_type='event_tech_req' 值随表名更新为 'task'
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. 三表改名 + 列改名 ────────────────────────────────────────────────────
ALTER TABLE event_tech_req RENAME TO task;
ALTER TABLE event_tech_req_item RENAME TO task_schedule_item;
ALTER TABLE event_tech_assignee RENAME TO task_assignee;
ALTER TABLE task_schedule_item RENAME COLUMN req_id TO task_id;
ALTER TABLE task_assignee RENAME COLUMN req_id TO task_id;

-- 约束/索引名对齐 schema.sql 新鲜安装的自动命名（改名不自动改约束名）
ALTER TABLE task RENAME CONSTRAINT event_tech_req_pkey TO task_pkey;
ALTER TABLE task RENAME CONSTRAINT event_tech_req_department_id_fkey TO task_department_id_fkey;
ALTER TABLE task RENAME CONSTRAINT event_tech_req_created_via_check TO task_created_via_check;
ALTER TABLE task_schedule_item RENAME CONSTRAINT event_tech_req_item_pkey TO task_schedule_item_pkey;
ALTER TABLE task_schedule_item RENAME CONSTRAINT event_tech_req_item_req_id_fkey TO task_schedule_item_task_id_fkey;
ALTER TABLE task_schedule_item RENAME CONSTRAINT event_tech_req_item_item_id_fkey TO task_schedule_item_item_id_fkey;
ALTER TABLE task_assignee RENAME CONSTRAINT event_tech_assignee_pkey TO task_assignee_pkey;
ALTER TABLE task_assignee RENAME CONSTRAINT event_tech_assignee_req_id_fkey TO task_assignee_task_id_fkey;
-- user_id FK 名因库的出身而异：迁移链演进库为 event_tech_assignee_user_fk
-- （migrate-internal-user-id 自定义命名），schema.sql 新装库为
-- event_tech_assignee_user_id_fkey（inline 自动名）——按存在者改名
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'task_assignee'::regclass
               AND conname = 'event_tech_assignee_user_fk') THEN
    ALTER TABLE task_assignee RENAME CONSTRAINT event_tech_assignee_user_fk TO task_assignee_user_id_fkey;
  ELSIF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'task_assignee'::regclass
                  AND conname = 'event_tech_assignee_user_id_fkey') THEN
    ALTER TABLE task_assignee RENAME CONSTRAINT event_tech_assignee_user_id_fkey TO task_assignee_user_id_fkey;
  END IF;
END $$;
ALTER INDEX event_tech_req_event_idx RENAME TO task_event_idx;
ALTER INDEX event_tech_req_item_req_idx RENAME TO task_schedule_item_task_idx;

-- ── 2. production_id 落列（从 event 回填；production 删除 CASCADE 兜底）─────
ALTER TABLE task ADD COLUMN production_id TEXT;
UPDATE task t SET production_id = pe.production_id
FROM production_event pe WHERE pe.id = t.event_id;
ALTER TABLE task ALTER COLUMN production_id SET NOT NULL;
ALTER TABLE task ADD CONSTRAINT task_production_id_fkey
  FOREIGN KEY (production_id) REFERENCES production(id) ON DELETE CASCADE;
CREATE INDEX task_production_idx ON task(production_id);

-- ── 3. event 绑定改可选：event 删除不再连坐删 task ──────────────────────────
ALTER TABLE task ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE task DROP CONSTRAINT event_tech_req_event_id_fkey;
ALTER TABLE task ADD CONSTRAINT task_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES production_event(id) ON DELETE SET NULL;

-- ── 4. 自身起止时间（可空；绑定 schedule/event 时读侧回落）─────────────────
ALTER TABLE task
  ADD COLUMN start_time TIMESTAMPTZ,
  ADD COLUMN end_time   TIMESTAMPTZ,
  ADD CONSTRAINT task_time_order_check
    CHECK (start_time IS NULL OR end_time IS NULL OR end_time >= start_time);

-- ── 5. 死列清理：schedule_item_id（代码零消费，绑定走 task_schedule_item）──
ALTER TABLE task DROP COLUMN schedule_item_id;

-- ── 6. 新表：里程碑关联（0..n；不约束 task 截止 ≤ 里程碑时间）──────────────
CREATE TABLE task_milestone (
  task_id      TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, milestone_id)
);

CREATE INDEX task_milestone_milestone_idx ON task_milestone(milestone_id);

-- ── 7. 新表：blocking 依赖边（blocking 挡住 blocked；纯信息性，禁自指，
--        环由应用层写入时递归 CTE 拒绝）────────────────────────────────────
CREATE TABLE task_dependency (
  blocking_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocking_id, blocked_id),
  CONSTRAINT task_dependency_no_self_check CHECK (blocking_id <> blocked_id)
);

CREATE INDEX task_dependency_blocked_idx ON task_dependency(blocked_id);

-- ── 8. 死账修复：'tech_req' 管理归属行并入 'task'（UNIQUE 冲突行直接弃）────
INSERT INTO resource_dept_manage
  (production_id, dept_id, resource_type, resource_id, resource_sub, established_by)
SELECT production_id, dept_id, 'task', resource_id, resource_sub, established_by
FROM resource_dept_manage WHERE resource_type = 'tech_req'
ON CONFLICT (production_id, dept_id, resource_type, resource_id, resource_sub) DO NOTHING;
DELETE FROM resource_dept_manage WHERE resource_type = 'tech_req';

-- ── 9. asset 挂载点词汇随表名更新 ───────────────────────────────────────────
UPDATE asset_mount SET mount_type = 'task' WHERE mount_type = 'event_tech_req';

COMMIT;
