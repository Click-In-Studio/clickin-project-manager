-- #141 成员退出（方案 B）：收窄 production_member.status 枚举。
--
-- #137 埋下的 CHECK 覆盖五个值：active / pending_exit / disputed / exited / suspended，
-- 那是「退出审批流」（方案 A）的状态机——发起退出后挂 pending_exit 等 14 天超时定谳，
-- 有人异议转 disputed。该方案已废弃，理由见 issue #141 讨论：
--
--   1. 假审批：pending_exit 期间访问权已经归零，结果先于「审批」生效，
--      「待审批」是产品在撒谎。
--   2. 死拒绝：投 object 只产生 disputed 标签，恢复仍需 owner 另一次 set active
--      ——那个动作不改变任何状态。
--   3. 沉默定谳：超时把 suspended 推进到 exited，而 exited 关联结算与署名。
--      系统可以催，不该用管理层的沉默替个人做人事判定。
--
-- 终局三态：
--   active    正常在职
--   suspended 访问权冻结、授权行原样保留（可复职，零重配）
--   exited    已离组，授权真撤（复用 revokeAllGrantsForMember），成员行与历史保留
--
-- 异议不再是状态，降级为 production_member_status_audit 里的一条 'object' 行
-- （见 db/add-member-exit-fields.sql）。

-- 前置：db/add-member-exit-fields.sql（字母序先跑）已建好 status_source 等列。
--
-- 线上无非 active 行（本 migration 编写时 status <> 'active' 计数为 0），
-- 但迁移必须自洽：任何残留的中间态归一到 suspended——它是三态里唯一可逆且零伤害的，
-- 归错方向的代价最小（人工推一下即可，不会误撤授权、也不会误还访问权）。
-- 归一时补上成因：pending_exit 只可能由成员自己发起，disputed 由此派生，故都是 'self'。
UPDATE production_member
   SET status = 'suspended',
       status_source = 'self',
       status_changed_at = COALESCE(status_changed_at, NOW())
 WHERE status IN ('pending_exit', 'disputed');

ALTER TABLE production_member
  DROP CONSTRAINT IF EXISTS production_member_status_check;

ALTER TABLE production_member
  ADD CONSTRAINT production_member_status_check
  CHECK (status IN ('active', 'suspended', 'exited'));

-- 跨列不变式：active 行不带成因，非 active 行必须带。装在残留行归一之后。
ALTER TABLE production_member
  DROP CONSTRAINT IF EXISTS production_member_status_source_check;

ALTER TABLE production_member
  ADD CONSTRAINT production_member_status_source_check
  CHECK ((status = 'active') = (status_source IS NULL));
