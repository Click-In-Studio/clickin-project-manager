-- 退役 org_dept 资源类型，并入 dept（#327）。
--
-- 背景：dept 与 org_dept 指的是**同一张 production_dept**。分裂是
-- migrate-merge-event-department 并表前的遗留——那时 dept = event_department
-- （业务部门）、org_dept = production_dept（组织树），是两张表两个概念。并表之后
-- 区别只剩「面」：org_dept 是部门本身的治理（建/删/改、成员、POC、权限行），
-- dept 只剩一个面 dept/<D>/notes（给某部门提备注）。
--
-- 留下的名字是 dept：产品里只有「部门」，没有「组织」这个概念，org_ 前缀是
-- 并表前用来跟 event_department 区分的，那个区分已经不存在了。
--
-- 方向选择的实际后果：notes 面**一行都不用动**——6 条存量授权行、7 处模板区间键、
-- dept.poc:notes@* 三个策略键连同 production_policy 里的存量覆盖、event-permissions
-- 的两处门，全部原地不变。要改的只有 org_dept 那一侧。
--
-- ⚠️ 语义变化：治理面与 notes 面此前靠**类型边界**隔离；并到同一类型后，隔离要靠
-- sub 边界，而 notes 不是保留段（RESERVED_SUBS 只有 grants/publication/assignees/
-- imports）。因此 dept 的 sub 通配行（dept/*/*@create 之类）此后会覆盖 notes 面。
--   * 今天实际受影响人数为 0：唯一持有该通配行的是制作人，而制作人的类型通配区间
--     node:*/*@* 本来就覆盖 dept/<D>/notes（dept 不在 RESERVED_TYPES）。
--   * 变的是规则不是账：此后任何拿到 dept 通配的人也能替任意部门提备注。
--   * 没走「把 notes 设成保留段」那条路：RESERVED_SUBS 是全局的，而 report 的
--     notes@edit 今天正是靠 *@edit 覆盖（REPORT_LEVEL_ROW_SETS 只显式发
--     notes@create/delete），设成保留段会静默收窄 report 侧。
--   * 管理面资格另行收口：lib/permissions.ts 把 notes 面排除在
--     ADMIN_PANEL_NODE_PREFIXES 的命中之外，否则「能替部门提备注」会顺带变成
--     「能进管理后台」（导演类模板持 node:dept/<D>/notes@create 的通配形）。
--
-- 幂等：所有语句条件式，可重复执行。
-- 顺序要求：词汇行（resource_permission_level）必须**最后**删——
-- production_member_grant 有 (resource_type, permission_level) 外键指向它。

BEGIN;

-- ── 0. 目标词汇齐备（外键前提）──────────────────────────────────────────────
-- 平移后的授权行要满足 production_member_grant 的
-- (resource_type, permission_level) → resource_permission_level 复合外键。
-- 现实中 dept 与 org_dept 登记的都是四动词闭集，这条是空操作；写在这里是让迁移
-- **自带前提**，而不是依赖「另一张表恰好已经有那四行」——照 org_dept 现有的动词
-- 集补齐 dept，无论那边登记了什么，平移都不会中途撞外键炸掉整个事务。
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order)
SELECT 'dept', permission_level, 0
FROM resource_permission_level WHERE resource_type = 'org_dept'
ON CONFLICT DO NOTHING;

-- ── 1. 授权行 ────────────────────────────────────────────────────────────────
-- 先清掉平移过去会撞活行唯一索引的那些（同人同节点同动词已有 dept 活行）。
-- 部分唯一索引只管 is_revoked = false，已撤销行随便平移。
DELETE FROM production_member_grant o
WHERE o.resource_type = 'org_dept'
  AND NOT o.is_revoked
  AND EXISTS (
    SELECT 1 FROM production_member_grant d
    WHERE d.resource_type = 'dept'
      AND NOT d.is_revoked
      AND d.production_id = o.production_id
      AND d.user_id = o.user_id
      AND d.resource_id = o.resource_id
      AND d.resource_sub = o.resource_sub
      AND d.permission_level = o.permission_level
  );

UPDATE production_member_grant SET resource_type = 'dept' WHERE resource_type = 'org_dept';

-- ── 2. 区间键（三张 permission 表）────────────────────────────────────────────
-- node:org_dept/<X>[/<sub>]@<v> → node:dept/<X>[/<sub>]@<v>
DELETE FROM production_dept_permission a
WHERE a.permission_key LIKE 'node:org_dept/%'
  AND EXISTS (
    SELECT 1 FROM production_dept_permission b
    WHERE b.dept_id = a.dept_id
      AND b.permission_key = replace(a.permission_key, 'node:org_dept/', 'node:dept/')
  );
UPDATE production_dept_permission
SET permission_key = replace(permission_key, 'node:org_dept/', 'node:dept/')
WHERE permission_key LIKE 'node:org_dept/%';

DELETE FROM production_role_permission a
WHERE a.permission_key LIKE 'node:org_dept/%'
  AND EXISTS (
    SELECT 1 FROM production_role_permission b
    WHERE b.role_id = a.role_id
      AND b.permission_key = replace(a.permission_key, 'node:org_dept/', 'node:dept/')
  );
UPDATE production_role_permission
SET permission_key = replace(permission_key, 'node:org_dept/', 'node:dept/')
WHERE permission_key LIKE 'node:org_dept/%';

DELETE FROM production_member_permission a
WHERE a.permission LIKE 'node:org_dept/%'
  AND EXISTS (
    SELECT 1 FROM production_member_permission b
    WHERE b.production_id = a.production_id
      AND b.user_id = a.user_id
      AND b.permission = replace(a.permission, 'node:org_dept/', 'node:dept/')
  );
UPDATE production_member_permission
SET permission = replace(permission, 'node:org_dept/', 'node:dept/')
WHERE permission LIKE 'node:org_dept/%';

-- ── 3. 在途审批申请 ──────────────────────────────────────────────────────────
-- 不改的话，一条 org_dept 的待批申请会在批准时发出一行死类型授权。
UPDATE approval_request SET resource_type = 'dept' WHERE resource_type = 'org_dept';

-- ── 4. 资源审批人配置（#262 的两张表）────────────────────────────────────────
DELETE FROM resource_dept_manage o
WHERE o.resource_type = 'org_dept'
  AND EXISTS (
    SELECT 1 FROM resource_dept_manage d
    WHERE d.production_id = o.production_id AND d.dept_id = o.dept_id
      AND d.resource_type = 'dept'
      AND d.resource_id = o.resource_id AND d.resource_sub = o.resource_sub
  );
UPDATE resource_dept_manage SET resource_type = 'dept' WHERE resource_type = 'org_dept';

DELETE FROM resource_person_manage o
WHERE o.resource_type = 'org_dept'
  AND EXISTS (
    SELECT 1 FROM resource_person_manage d
    WHERE d.production_id = o.production_id AND d.user_id = o.user_id
      AND d.resource_type = 'dept'
      AND d.resource_id = o.resource_id AND d.resource_sub = o.resource_sub
  );
UPDATE resource_person_manage SET resource_type = 'dept' WHERE resource_type = 'org_dept';

-- ── 5. 词汇退役（必须最后：production_member_grant 的复合外键指向这张表）──────
-- 策略键（dept.poc:notes@*）与 production_policy 存量不在本迁移范围内：
-- 留下的就是 dept 这个名字，那三个键一个字都没变。
DELETE FROM resource_permission_level WHERE resource_type = 'org_dept';

COMMIT;
