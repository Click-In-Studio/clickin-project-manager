# PRD：人事与权限系统 v2（Epic #166）

> 状态：草稿  
> 最后更新：2026-07-31  
> 对应 Issues：#166（epic）、#137、#138、#139、#140、#141、#158、#163、#164、#165  
> UI：#156（穿插）

---

## 目标

将人事管理、部门体系、权限系统、审批流整合为一套统一、可扩展的 production-level 系统，支持未来的细粒度资源域权限（cue 表、tech req、note、物料、财务）。

---

## 已确认的设计决策

### D1. 部门系统统一

- **废弃** `event_department` / `event_department_member` 表，数据迁移至新的 `production_dept` / `production_dept_member`
- 原"群组（group）"功能**暂时搁置**（飞书多平台适配性不佳）
- 飞书群绑定功能保留，但仅针对 dept 类型，迁移时原 `chat_id` 跟着数据一起迁

### D2. 权限继承方向：标准 RBAC（从上往下）

- 父部门设置的 `permissions[]` 自动向子部门成员继承
- 例：演员部门有 `[view_cast_list]` → 歌队成员自动拥有此权限

### D3. POC 权限特殊规则

- POC 默认获得其**直属子部门及本部门所有权限的并集**（向下递归）
- 在此基础上可配置 `poc_extra_permissions` 和 `poc_blocked_permissions`
- 快捷屏蔽：`poc_block_write_from_children = true` 屏蔽来自子部门的 create/edit/delete 类权限

### D4. roles vs tags 语义分离

- `role`（职位）= 具体职能，如"导演"、"灯光设计"、"舞台监督"
- `tag`（标签）= 描述性修饰，如"正式"、"副"、"助理"、"实习"、"顾问"、"外包"
- **禁止出现"导演助理"这类复合 role**，用 `role="导演" + tag="助理"` 替代
- 需要 migration：将现有助理类 role 拆分

### D5. roles 改为 FK 引用（修复 TEXT[] 断链问题）

- 现有 `production_member.roles TEXT[]` 通过字符串 JOIN `production_role.name`，角色重命名会静默断链
- 新增 `production_member_role` 关联表，用 `role_id` 外键替代字符串数组
- 同步更新 `getProductionPermissionContext` 查询路径

### D6. 资源域权限（Resource-Scoped Permissions）

不同类型的资源使用不同的域模型，不是统一的"部门 Scope"。见下方"资源域权限模型"章节。

### D7. 剧本（script）和 Dramaturgy 资源为 dept-scoped

- script 的 `owner_dept_id` = 编导组（编剧、导演、戏剧构作所在部门）
- `script:view` 从 `MEMBER_BASE_PERMISSIONS` 中移除（#158 负责），默认不对外开放
- 其他部门通过制作人的部门权限配置批量开放，或通过申请-访问流程单独获得
- 未来预留 `script:view_partial`（演员只看自己台词）

### D8. 资源访问走"申请-访问"模型，不依赖管理员手动 override

见下方"申请-访问模型"章节。

### D9. Production 是权限的严格边界

一个 production 内的任何 grant、role、dept 归属，对其他任何 production 均无任何含义。这是架构层的强约束（所有权限相关表都以 production_id 为作用域），不能也不允许跨 production 共享权限状态。

用户的身份（`app_user`、`user_profile`）跨 production 共享，但权限不共享。

### D10. 最小权限模型（Least-Privilege）

**核心转变**：role/dept 的 `permissions[]` 不再是"持有的权限集"，而是**"免审批获得权限的资格区间"**。

- 成员加入演出后默认 **零权限**
- `MEMBER_BASE_PERMISSIONS` 缩减为 3-4 个真·存在权限（见下表）
- 访问任何资源 → 系统检查是否在 role/dept 的免审批区间内 → 是则自动 grant（无感知）→ 否则触发申请流
- 制作人可将 role/dept 权限配置得极小（强管控模式）或极大（等同于当前系统行为）
- 所有 grant 均写入 `resource_grant` 表，提供完整审计记录

真·基础权限（无需任何配置，加入即有）：
- 知道自己是这个演出的成员
- 查看自己的个人档案
- 查看演出基本信息（名称、类型、日程摘要）

其余全部（包括 `contacts:view`、`event:follow` 等）移入 role/dept 权限配置，由制作人决定开放范围。

### D11. tags 使用关联表存储

`production_member.tags TEXT[]` 改为 `production_member_tag_assignment` 关联表，因为 production 可以有自定义 tag，且未来 tag 可能需要携带元数据（如有效期）。

---

## 资源域权限模型

### 资源的四种域类型

| 域类型 | 含义 | 例子 |
|--------|------|------|
| **creator-owned** | 所有者 = 创建个人，分享是主动行为 | asset（数字资产） |
| **dept-scoped** | 所有者 = 部门，成员资格决定访问权 | cue_list、tech_req、note（写）、物料、预算 |
| **production-wide** | 成员资格即基础访问，演出级别管理 | script、announcement |
| **event-scoped** | 绑定特定排练/演出场次 | report |

### 资源清单与域归属

| 资源 | 域类型 | 写权限 | 读权限 | 当前状态 |
|------|-------|-------|-------|---------|
| cue_list | dept-scoped | 本部门（`allowed_cue_types`） | 默认全员可读 | 已实现，需改 |
| tech_req | dept-scoped | 本部门 | 默认全员可读 | 已实现 |
| note | dept-scoped（写）/ production-wide（读） | 本部门成员/POC；SM、导演有 `_any` | 全员可读 | 已实现，需改 |
| asset（数字资产） | creator-owned | 上传者控制分享目标 | 按分享设置 | 已实现，需改 |
| 物料（实物资产） | dept-scoped | 本部门 | 默认全员可查 | 待实现 |
| budget / 财务 | dept-scoped | 本部门 POC；制作人有 `_any` | 本部门成员；制作人 `_any` | 待实现 |
| script / blocks | dept-scoped（owner = 编导组） | `script:edit` | `script:view`（非全员默认，需申请或部门配置）| 已实现，权限需修正 |
| announcement | production-wide | 管理员 | 配置可见范围 | 已实现 |
| report | event-scoped | SM + 相关部门 | 配置可见范围 | 已实现 |

### 核心 Grant 表（权限的单一权威）

所有实际权限均来源于 `resource_grant` 表。**没有静默的自动 grant**——每条记录都有明确的责任人（用户自己确认、他人审批、或管理员直接授权）。

```sql
resource_grant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  grantee_type    TEXT NOT NULL CHECK (grantee_type IN ('user', 'dept')),
  grantee_id      TEXT NOT NULL,          -- user_id 或 dept_id
  resource_type   TEXT NOT NULL,          -- 'cue_list' | 'script' | 'note' | 'tech_req' | '*'
  resource_id     TEXT NULL,              -- NULL = 该类型所有资源（dept 级 grant）
  permission_level TEXT NOT NULL CHECK (permission_level IN ('view', 'write', 'manage')),
  grant_source    TEXT NOT NULL CHECK (grant_source IN (
                    'self_confirmed',  -- 用户在免审批区间内主动自我确认
                    'approval',        -- 申请流审批通过（POC / 制作人批准）
                    'direct'           -- 制作人或 POC 直接授权（无需用户申请）
                  )),
  -- 'self_confirmed' 时：confirmed_by = subject_id（用户自己）
  -- 'approval' 时：approval_id 关联审批记录
  -- 'direct' 时：confirmed_by = 授权人 user_id
  confirmed_by    UUID REFERENCES app_user(id) NOT NULL,
  approval_id     UUID REFERENCES approval_request(id) NULL,
  is_revoked      BOOLEAN NOT NULL DEFAULT false,    -- 软删除（审计保留）
  revoked_reason  TEXT NULL,                         -- 'role_change' | 'dept_change' | 'manual'
  expires_at      TIMESTAMPTZ NULL,                  -- NULL = 永久
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (production_id, grantee_type, grantee_id, resource_type, resource_id, permission_level)
    WHERE is_revoked = false
)
```

`resource_permission_override` 和 `cue_list_permission` 表均归并至此表（Phase 3/4 迁移，迁移后的 grant_source 追溯为 'direct'）。

### 三种权限流程

| 流程 | 触发条件 | grant 创建者 | 用户感知 |
|------|---------|------------|---------|
| **自我确认** | 操作在免审批区间内，该资源无 grant 记录 | 用户主动确认 | 明确感知（确认对话框） |
| **申请流** | 操作不在免审批区间内 | POC/制作人批准后系统创建 | 明确感知（申请 → 等待 → 通知） |
| **直接授权** | 制作人/POC 主动发起 | 制作人/POC 写入 | 被授权方收到通知（被动知情） |

### 自我确认（Self-Confirmation）

自我确认是用户对自己职权范围的主动声明，是最小权限模型在 UX 层面成立的关键机制：

**触发时机**：有 grant 记录 → 直接放行；无 grant 但在免审批区间内 → 触发自我确认 UI。

**确认 UI 语义**（用户在确认三件事：角色 + 范围 + 责任）：

```
你正在以「编剧」身份开始编辑《剧名》的剧本
这是你在《演出名》中的职权范围内的操作，将被记录

[开始编辑]   [取消]
```

**确认粒度**：自我确认是 **一次性的**，确认后 grant 永久有效（直到 role/dept 变更触发撤销）。一个成员在整个演出周期里通常只会遇到 3-5 次确认。

**View vs Write 的区分**（仅影响首次确认的形式）：

| 操作类型 | 首次确认方式 | 后续操作 |
|---------|------------|---------|
| 首次查看敏感资源（script、财务） | 轻量通知（无需点击，自动创建 view grant + 页面提示"本次访问已记录"） | 无感知，直接放行 |
| 首次写入/编辑某类资源 | **显式确认对话框**（用户主动点击） | 无感知，直接放行 |
| Root / 敏感权限操作 | **每次执行都需要真·确认**（re-auth 或强确认），不适用 grant 持续性 | 每次都确认（true sudo 行为） |
| 破坏性操作（删除、归档非敏感资源） | 独立操作确认（与 grant 无关，grant 已存在也需此确认） | 每次都确认 |

### 访问检查流程

```
canAccess(user, action, resource):

  步骤 1: 查 resource_grant（is_revoked=false，expires_at > NOW() 或 NULL）
    grantee = user 本人 OR user 所在任一 dept
    resource 匹配（精确 resource_id OR resource_id=NULL 的类型级 grant）
    → 命中 → 允许

  步骤 2: 检查免审批区间（role + dept permissions[]）
    user 的 role/dept 是否覆盖此 resource 的此 action?
    → 在区间内 → 返回"需自我确认"状态（前端显示确认 UI，用户点击后写入 grant）

  步骤 3: 两者都不满足
    → 返回"需申请"状态（前端显示申请访问 UI）
```

### role/dept 变更时的 grant 级联撤销

```
成员 role 或 dept 变更时：
  1. 重新计算新免审批区间
  2. 查该用户 grant_source = 'self_confirmed' 的所有未撤销 grant
  3. 对比：grant 对应的操作是否仍在新免审批区间内？
     是 → 保留
     否 → 软删除（is_revoked=true, revoked_reason='role_change'/'dept_change'）
  4. grant_source = 'approval' / 'direct' → 不受影响（明确的人工决策）
```

步骤 2 的 auto-grant 写入异步（fire-and-forget），不阻塞实际访问响应。

### 三层权限 Scope（dept-scoped 类资源）

| Scope | 含义 | role/dept permissions[] 配置 |
|-------|------|---------------------------|
| 无 | 无法操作，需申请 | 不包含该权限 |
| Base（dept-scoped） | 本部门归属资源可免审批 | 包含 `cue_list:edit` |
| Any | 任意归属资源可免审批 | 包含 `cue_list:edit_any` |

"本部门归属"判断：用户所在部门及其所有祖先部门归属的资源均在用户的免审批区间内（向上遍历）。

### asset（数字资产）的特殊模型

数字资产由上传者自主决定分享目标，不走 dept-scoped 检查：

```sql
asset_share (
  asset_id    TEXT REFERENCES asset(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('user', 'dept', 'production')),
  target_id   TEXT NOT NULL,   -- user_id | dept_id | production_id
  PRIMARY KEY (asset_id, target_type, target_id)
)
```

| 权限 | 语义 |
|------|------|
| `asset:upload` | 任何成员均可上传 |
| `asset:view` | 只能看分享给自己/自己部门/全演出的 asset |
| `asset:view_any` | 无视分享设置，看所有 asset |
| `asset:delete` | 删除自己上传的 asset |
| `asset:delete_any` | 删除任何人的 asset |

### 物料（实物资产）vs asset（数字资产）

| 维度 | asset（数字） | 物料（实物） |
|------|-------------|------------|
| 所有权 | 创建个人 | 登记部门 |
| 分享模型 | 上传者主动分享 | 跨部门借用申请 → POC 确认 |
| 跨部门访问 | 分享设置决定 | 走 `approval_request`（type: `material_borrow`） |
| 管理员权限 | `asset:view_any` / `delete_any` | `物料:manage_any` |

### 有效权限计算（最小权限模型下的两层结构）

```
第一层：免审批区间（role/dept permissions[]，决定是否需要人工审批）
  免审批区间 =
    role 权限（production_member_role → production_role_permission）
    ∪ 所在部门公共权限（所有祖先部门 permissions[]，向上遍历）
    ∪ POC 权限（若为 POC：所有子孙部门权限并集 + poc_extra − poc_blocked）

第二层：实际持有权限（resource_grant 表，是访问的真实依据）
  实际权限 =
    resource_grant 中有效记录（grantee = 本人或本人所在部门，expires_at > NOW() 或 NULL）
    其中 grant_source 为：
      'auto'     — 首次访问时由免审批区间自动创建
      'approval' — 申请流审批通过后创建
      'direct'   — 制作人或 POC 直接授权

权限检查流程：先查第二层（快，O(1) 索引）→ 未命中再查第一层 → 仍未命中则需申请
```
```

### cue_list 特殊处理

- `production_dept` 新增 `allowed_cue_types TEXT[]` 字段，替代现有 `production_role_cue_type` 表
- 例：灯光部门 → `['lighting', 'followspot']`；音响部门 → `['sound', 'music']`
- 废弃 `CUE_LIST_TEMPLATES.creatorRoles` / `defaultRoles` 的 role 绑定逻辑，改为 dept 绑定
- `cue_list` 新增 `owner_dept_id UUID REFERENCES production_dept`
- 迁移：Phase B（见迁移计划）枚举现有演出的 role → dept 映射，手动确认后写入

### note 的 domain 确认

- **写**：dept-scoped（本部门 POC 和成员可写自己部门的 note）
- **特殊写权限**：`note:create_any` 给 SM 和导演（跨部门写 note）
- **读**：production-wide（所有成员默认可见全部 note），未来可按需收紧

---

## 申请-访问模型（Request-Access）

### 设计原则

资源访问权限的变更**优先通过申请流程**获取，而非由管理员手动 override。理由：手动 override 要求管理员预判所有需求；申请流则让需求方主动表达，权限变更有完整记录。

制作人保留直接 grant 的能力（不走申请流），作为管理员紧急通道。

### 审批路由

```
用户申请访问某资源
  ↓
resource.owner_dept_id → 找到该 dept 的所有 POC
  ↓
有 POC → 通知所有 POC（任一批准即可）
无 POC → 找 parent_dept 的 POC（递归向上）
最终无 POC → 交给制作人（兜底）
```

**POC 天然有权批准本部门资源的访问申请**，不需要额外校验 POC 是否持有对应权限。Sound supervisor 是音响部门 POC → 可以批准所有关于 sound cue 的访问申请。

多 POC 时：任一 POC 批准即生效；若有争议（一批一拒）→ 升级至父部门 POC 或制作人。

### 可授予的权限组合

| 授权目标 | 授权时限 | 权限级别 | 存储方式 |
|---------|---------|---------|---------|
| 个人 | 永久 | view / write | `resource_permission_override`，`expires_at = NULL` |
| 个人 | 限时 | view / write | `resource_permission_override`，`expires_at = T` |
| 部门 | 永久 | view / write | `production_dept.permissions[]`（结构性修改） |
| 部门 | 限时 | view / write | `resource_permission_override`，`target_type = 'dept'`，`expires_at = T` |

### 批准后自动执行

审批状态变为 `approved` 时，系统自动根据 `grant_target_type` 执行写入：

```
approval_request.status → 'approved'
  if grant_target_type = 'user':
    INSERT INTO resource_permission_override (user, resource, permission_level, expires_at)
  if grant_target_type = 'dept' AND grant_type = 'permanent':
    UPDATE production_dept SET permissions = array_append(permissions, permission_level)
    WHERE id = grant_target_id
  if grant_target_type = 'dept' AND grant_type = 'ttl':
    INSERT INTO resource_permission_override (target_type='dept', target_id, resource, expires_at)
```

限时权限查询时 filter `expires_at > NOW()`，不需要主动清理任务。

### 与 #140 的关系

**不是独立新系统**，就是 `approval_request.type = 'resource_access'`，复用同一张表。`approval_request` 需要扩展 resource 相关字段（见 Schema 章节）。

---

## 数据库 Schema

### 新建表

#### `production_dept`（替代 `event_department`）

```sql
CREATE TABLE production_dept (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  parent_id       UUID REFERENCES production_dept(id) NULL,  -- NULL 为顶级部门
  permissions     TEXT[] NOT NULL DEFAULT '{}',              -- 向下继承给子部门成员
  allowed_cue_types TEXT[] NOT NULL DEFAULT '{}',            -- 本部门可创建的 cue 类型
  display_order   INTEGER NOT NULL DEFAULT 0,
  chat_id         TEXT,                                      -- 飞书群 chat_id（迁移自 event_department）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (production_id, name, parent_id)
);
```

#### `production_dept_member`（替代 `event_department_member`）

```sql
CREATE TABLE production_dept_member (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  dept_id         UUID NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  is_poc          BOOLEAN NOT NULL DEFAULT false,
  poc_extra_permissions   TEXT[] NOT NULL DEFAULT '{}',
  poc_blocked_permissions TEXT[] NOT NULL DEFAULT '{}',
  poc_block_write_from_children BOOLEAN NOT NULL DEFAULT false,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, dept_id)
);
```

#### `production_member_role`（替代 `production_member.roles TEXT[]`）

```sql
CREATE TABLE production_member_role (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id       TEXT NOT NULL REFERENCES production_role(id) ON DELETE CASCADE,
  PRIMARY KEY (production_id, user_id, role_id)
);
```

#### `production_member_tag`（#165，标签定义表）

```sql
CREATE TABLE production_member_tag (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT REFERENCES production(id) ON DELETE CASCADE NULL,  -- NULL 为系统预设
  name          TEXT NOT NULL,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (production_id, name)
);
-- 系统预设 seed：正式、副、助理、实习、顾问、外包
```

#### `production_member_tag_assignment`（成员-标签关联）

```sql
CREATE TABLE production_member_tag_assignment (
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  tag_id        UUID NOT NULL REFERENCES production_member_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (production_id, user_id, tag_id)
);
```

替代原方案中的 `production_member.tags TEXT[]`（允许自定义 tag，未来可扩展 tag 元数据）。

#### `approval_request`（#139，扩展了资源访问申请字段）

```sql
CREATE TABLE approval_request (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN (
                  'member_exit',      -- #141 成员退出
                  'owner_transfer',   -- #139 owner 转让确认
                  'resource_access'   -- 资源访问申请（本次新增）
                )),
  entity_id     TEXT NOT NULL,        -- production_id（或 org_id）
  subject_id    UUID NOT NULL REFERENCES app_user(id),  -- 申请人

  -- 资源访问申请专用字段（type = 'resource_access' 时非 NULL）
  resource_type       TEXT NULL,      -- 'cue_list' | 'script' | 'note' | 'tech_req' | ...
  resource_id         TEXT NULL,      -- 具体资源 id（NULL = 该部门下所有此类资源）
  permission_level    TEXT NULL CHECK (permission_level IN ('view', 'write', 'manage')),
  grant_target_type   TEXT NULL CHECK (grant_target_type IN ('user', 'dept')),
  grant_target_id     TEXT NULL,      -- user_id 或 dept_id（NULL = subject_id 本人）

  -- 授权结果
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'auto_approved', 'disputed')),
  grant_type    TEXT CHECK (grant_type IN ('permanent', 'one_time', 'ttl')) NULL,
  ttl_duration  INTERVAL NULL,
  granted_at    TIMESTAMPTZ NULL,
  expires_at    TIMESTAMPTZ NULL,

  escalation_chain JSONB NOT NULL DEFAULT '[]',  -- [{approver_id, action, timestamp, reason}]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ NULL,
  resolved_by   UUID REFERENCES app_user(id) NULL
);
```

### 修改现有表

#### `production_member`

```sql
ALTER TABLE production_member
  ADD COLUMN supervisor_id UUID REFERENCES app_user(id) NULL,
  -- supervisor_id 循环防护：应用层检查，不允许形成循环链（A→B→A 或更长链）
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'pending_exit', 'disputed', 'exited', 'suspended'));
-- roles TEXT[] 字段：保留直至 production_member_role migration 完成后 DROP
-- tags TEXT[] 字段：不新增，改用 production_member_tag_assignment 关联表
```

#### `cue_list`（新增 dept 归属字段）

```sql
ALTER TABLE cue_list
  ADD COLUMN owner_dept_id UUID REFERENCES production_dept(id) ON DELETE SET NULL NULL;
-- 替代现有 cue_list_role 的 dept-scoped 检查逻辑
```

---

## 迁移计划

> **原则**：每个激活最小权限检查的 Phase 必须同时交付对应的 UX（自我确认 + 申请访问入口），不能先上后端、UI 留到最后。

### Phase 0（前置，无代码）
- [ ] 确认 `allowed_cue_types` 枚举值与 `CUE_LIST_TEMPLATES` 的 key 对应
- [ ] 整理现有 role 中助理类职位清单（`ASSISTANT_ROLE_MIGRATION`），准备拆分 migration
- [ ] 确认 `resource_grant` 旧数据回填策略（现有 `cue_list_permission` + `production_member_permission` 如何转换为 grant 记录）

### Phase 1（#158）权限体系基础设施
**后端：**
- 重新定义权限枚举，明确 base/`_any` 的 dept-scoped 语义，role/dept `permissions[]` 语义变更为"免审批区间"
- `MEMBER_BASE_PERMISSIONS` 缩减至 3 项（production 成员身份、个人档案、演出基本信息）
- `add-resource-grant.sql`：新建 `resource_grant` 表（含 grant_source、is_revoked、confirmed_by 等字段）
- 引入 `canAccess(user, action, resource)` 函数，此时内部仍调用 `hasPermission()` 作为回落——**用户无感知变化**
- 确定可赋给 dept 的权限集合（排除 root 和 sensitive admin）

**无 UX 变化**（canAccess 暂时等同 hasPermission，只是建立基础设施）

### Phase 2（#137）成员关系模型
**后端：**
- `add-production-dept.sql`：新建空的 `production_dept` 表（不动 `event_department`）
- `add-production-dept-member.sql`：新建 `production_dept_member` 表
- `migrate-member-roles.sql`：新建 `production_member_role` 表，迁移 `production_member.roles TEXT[]` 数据，保留旧字段至 Phase 3 确认后 DROP
- `add-production-member-fields.sql`：新增 `supervisor_id`（含循环引用防护）、`status` 字段
- `add-production-member-tag.sql`：新建 `production_member_tag`（含系统预设 seed）+ `production_member_tag_assignment` 关联表
- `getProductionPermissionContext` 更新走 `production_member_role` FK 表
- Role 变更时触发 `self_confirmed` grant 级联撤销（revoked_reason='role_change'）

**无 UX 变化**

### Phase 3（#164 + #163 + event_department 迁移）部门系统
**后端：**
- `migrate-event-department.sql`：`event_department` / `event_department_member` 数据迁移至 `production_dept` / `production_dept_member`，迁移 `chat_id`
- 废弃 `event_department` 相关 API，新建 `/api/production/[id]/depts` 路由
- 实现部门权限**向下继承**逻辑（父部门 permissions[] 向子部门成员传递）
- 实现 POC 权限计算（子孙部门权限并集 + poc_extra − poc_blocked）
- Dept 成员变更时触发 `self_confirmed` grant 级联撤销（revoked_reason='dept_change'）
- 审批路由算法：resource_access 申请 → resource.owner_dept 的 POC → 父部门 POC → 制作人
- POC 冲突处理（祖先/后代关系自动调整，非静默提示）
- `canAccess()` 更新：将 dept 免审批区间纳入计算

**无 UX 变化**

### Phase 4（cue list + 最小权限模型首次对用户可见）
**后端：**
- `add-cue-list-dept.sql`：`cue_list` 新增 `owner_dept_id` 字段；`production_dept` 新增 `allowed_cue_types[]`
- 枚举迁移：`production_role_cue_type` → `production_dept.allowed_cue_types`（role→dept 映射，手动确认后写入）
- 回填：现有 `cue_list_permission` 和 `cue_list_role` 数据迁移为 `resource_grant` 记录（grant_source='direct'）
- `canAccess()` 对 cue_list 类型完全切换为 resource_grant 查询（移除 hasPermission 回落）
- 废弃 `cue_list_role` 表

**UX（与后端同 Phase 交付）：**
- 自我确认对话框：灯光设计首次打开灯光 cue 表 → 确认"你正在以[角色]身份编辑此 cue 表"
- "申请访问"界面：访问不在免审批区间的 cue 表 → 显示申请入口（替代纯 403）
- View 首次访问的轻量通知

### Phase 5（#165 + #138）标签 + 成员管理 API
**后端：**
- migration：将现有 roles 中助理类复合职位拆分（role=原职位、tag=助理）
- 补充标签 CRUD API（系统预设 + 自定义标签）
- 重写 `PATCH /api/production/[id]/members` 路由（supervisor_id / tags / role / dept / status 全覆盖）
- `DELETE /api/production/[id]/members/[userId]`（owner only，级联撤销所有 self_confirmed grant）
- 制作人/POC 直接写入 `resource_grant(source='direct')` 的 API

**UX：**
- 成员详情页展示 tags 和 role（分开显示）
- 成员列表支持按 tag 筛选

### Phase 6（#139 → #140 → #141）审批流
**后端：**
- `add-approval-request.sql`：新建 `approval_request` 表（含 resource_access type 及其专用字段）
- Resource access 申请提交 API
- 审批 API（POC 批准/拒绝）
- 批准后自动写 `resource_grant(source='approval')`
- Member exit 状态机（active → pending_exit → approved/disputed → exited/suspended）
- Owner transfer 双向确认

**UX：**
- 申请提交后的状态追踪页
- POC 收到申请的通知 + 审批操作界面（Inbox）
- Member exit 申请界面
- Grant 撤销后收到通知

### Phase 7（#156）UI 完整收尾
- 其余资源类型（script、note、tech_req 等）的自我确认 UI 与申请访问 UI
- Grant 管理界面（用户查看自己的 grants；制作人查看全演出 grant 记录）
- Inbox 完整实现（资源申请、成员退出申请、grant 撤销通知聚合）
- 审批流历史记录展示

---

## POC 上级冲突处理规则

当一个用户被设置为某部门 POC 时，如果他已经是其他部门的 POC：

- 新部门是旧部门的**祖先**：保留新部门 POC，撤销旧部门 POC（范围更广，旧的被包含）
- 新部门是旧部门的**后代**：保留旧部门 POC，忽略新操作（旧的范围更广，已包含新的）
- 新旧部门**无祖先关系**：允许同时担任多个平行部门的 POC

上述处理**不静默**：操作完成后返回提示信息，说明哪些 POC 关系被自动调整。

---

## 未解决问题（待后续讨论）

- [ ] **script 的访问分层**：已确认 script 为 dept-scoped（owner = 编导组），`script:view` 从 MEMBER_BASE_PERMISSIONS 移除。演员只看自己台词的 `script:view_partial` 预留但本次不实现
- [ ] **物料的借用流程**：approval_request 的 `type` 字段是否新增 `material_borrow`，还是物料借用走独立流程？
- [ ] **财务/物料的权限 key 枚举**：`物料:manage`、`budget:view` 等具体 key 待 #158 确定后补充
- [ ] **supervisor_id 跨演出**：supervisor 不在同一 production 时如何处理审批链爬升（临时 supervisor = 制作人）？
- [ ] **asset_share 的实现时机**：asset 分享功能是否在本次 epic 内实现，还是仅做 schema 预留？

---

## 明确不在本次范围内

- 组织级（Org-level）的人事管理
- 飞书群组功能的多平台扩展（群组类型搁置）
- 跨演出的成员档案同步
