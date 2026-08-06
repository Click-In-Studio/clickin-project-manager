# PRD：人事与权限系统 v2（Epic #166）

> 状态：草稿  
> 最后更新：2026-07-31（资源域权限模型重构：平权共管 + 两级资源ID + TTL升级审批路由）  
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
- 快捷屏蔽：将子部门的 create/edit/delete 类权限 key 写入 `poc_blocked_permissions[]` 即可屏蔽（原 `poc_block_write_from_children` 字段已合并至此，不再单独存储）

### D4. roles vs tags 语义分离

- `role`（职位）= 具体职能，如"导演"、"灯光设计"、"舞台监督"
- `tag`（标签）= 描述性修饰，如"正式"、"副"、"助理"、"实习"、"顾问"、"外包"
- **禁止出现"导演助理"这类复合 role**，用 `role="导演" + tag="助理"` 替代
- 需要 migration：将现有助理类 role 拆分
- **tag 纯描述性，不参与权限计算**：`production_member_tag_assignment` 仅用于展示与筛选，权限引擎不读取 tag 维度。若未来需要"外包/实习成员权限受限"，需另行设计 tag → 权限映射机制（当前明确不支持）。

### D5. roles 改为 FK 引用（修复 TEXT[] 断链问题）

- 现有 `production_member.roles TEXT[]` 通过字符串 JOIN `production_role.name`，角色重命名会静默断链
- 新增 `production_member_role` 关联表，用 `role_id` 外键替代字符串数组
- 同步更新 `getProductionPermissionContext` 查询路径

### D6. 资源域权限（Resource-Scoped Permissions）

不同类型的资源使用不同的域模型，不是统一的"部门 Scope"。见下方"资源域权限模型"章节。

### D7. 剧本（script）使用原子权限，行级控制通过 script_view 实现

- script 是演出版本级单例（每个版本一份），无需 per-instance 分控，通过原子权限（`script:view`、`script:edit_content`、`script:edit_marker`）控制访问，**不使用 resource_grant**
- `script:view` 从 `MEMBER_BASE_PERMISSIONS` 中移除（#158 负责），默认不对外开放；成员访问剧本需主动发起申请
- 编导组/SM 等部门通过 role/dept `permissions[]` 配置获得免审批区间；其他成员通过申请流获得
- 行级访问控制（演员、顾问等只看部分 block）通过 `script_view` 资源实现——`script_view` 是 resource_grant 体系内的独立资源实体，每个视图是一个可独立 grant 的 instance

### D8. 资源访问走"申请-访问"模型，不依赖管理员手动 override

见下方"申请-访问模型"章节。

### D9. Production 是权限的严格边界

一个 production 内的任何 grant、role、dept 归属，对其他任何 production 均无任何含义。这是架构层的强约束（所有权限相关表都以 production_id 为作用域），不能也不允许跨 production 共享权限状态。

用户的身份（`app_user`、`user_profile`）跨 production 共享，但权限不共享。

### D10. 最小权限模型（Least-Privilege）

**核心转变**：role/dept 的 `permissions[]` 不再是"持有的权限集"，而是**"免审批获得权限的资格区间"**。

- 成员加入演出后默认 **零权限**
- `MEMBER_BASE_PERMISSIONS` 缩减为 3-4 个真·存在权限（见下表）
- 权限确认分三级触发（见「权限确认 UX」章节）：view 级权限通过 Level 1 进入演出时批量确认；edit/manage 级权限在首次进入对应编辑界面时由 Level 2-A 一次性确认；通配符/创建权限在进入资源总览页时由 Level 2-B 确认；不在免审批区间则进入审批流等待 POC 批准
- 以下情况下接收方**无需任何确认**，grant 直接生效：①加入演出时的 3 条基础 grant（`grant_source='auto'`）；②`grant_source='assigned'` 的操作触发型 grant（见「操作触发型 Grant」章节）；③`grant_source='direct'` 的制作人直接授权
- 制作人可将 role/dept 权限配置得极小（强管控模式）或极大（等同于当前系统行为）
- 所有 grant 均写入 grant 表（`atomic_permission_grant` 或 `resource_grant`），提供完整审计记录

真·基础权限（无需任何配置，加入即有）：
- 知道自己是这个演出的成员
- 查看自己的个人档案
- 查看演出基本信息（名称、类型、日程摘要）

其余全部（包括 `contacts:view`、`event:follow` 等）移入 role/dept 权限配置，由制作人决定开放范围。

### D11. tags 使用关联表存储

`production_member.tags TEXT[]` 改为 `production_member_tag_assignment` 关联表，因为 production 可以有自定义 tag，且未来 tag 可能需要携带元数据（如有效期）。

---

## 资源域权限模型

### 资源ID体系（多级路径格式）

资源使用统一的多级路径格式标识：

```
resource_type[:instance_id[:sub_type]]

scene                      # 所有场景（类型级）
scene:scene#               # 某个具体场景（全字段）
scene:*:stage_notes        # 所有场景的 stage_notes 字段（列级）
scene:scene#:music         # 某个场景的 music 字段
cue_list:list#             # 某个 cue list（全字段）
cue_list:list#:entries     # 某个 cue list 的 cue 条目
cue_list:list#:name        # 某个 cue list 的名称
script_view:view#          # 某个 script 视图（见下方 script 专项）
```

**继承规则**：高层级路径的 grant 自动覆盖所有子路径。`scene @ manage` 隐含 `scene:*:* @ view/edit/...`。

**稀疏性原则**：
- **Scene**：保留所有路径层级的 grant 能力，但非通配符（per-instance）grant 应尽量稀疏。一个演出最多几十个 scene，且 scene 几乎不需要行级隐藏，主要用途是列级编辑权（`scene:*:column_name @ edit`）。
- **Script**：**不使用 resource_grant**。script 本身通过原子权限控制（`script:view`、`script:edit_content`、`script:edit_marker`），行级访问通过 `script_view` 资源实现——`script_view` 是 resource_grant 体系内的独立实体（每个视图是一个可 grant 的 instance）。

**DB 存储**（`resource_grant` 表新增字段）：

```sql
resource_type  TEXT NOT NULL,              -- 顶层类型：'scene' | 'cue_list' | 'script' | ...
resource_id    TEXT NOT NULL DEFAULT '*',  -- 实例 ID；'*' = 通配符（所有实例）
resource_sub   TEXT NOT NULL DEFAULT '*',  -- 子类型/字段；'*' = 所有子类型
-- 预留第四层（暂不启用）：resource_sub_id TEXT NOT NULL DEFAULT '*'
```

> **为什么用 `'*'` 而不是 NULL**：`(col IS NULL OR col = ?)` 对 B-tree 索引不友好；`col = ANY(ARRAY['scene123', '*'])` 可以直接命中索引。

**权限查询模式**：

```sql
-- 检查 user 对 scene:scene123:music 是否有 edit 权限
SELECT 1 FROM resource_grant
WHERE production_id = $1
  AND is_revoked = false
  AND (expires_at IS NULL OR expires_at > NOW())
  AND user_id = $user_id
  AND resource_type = 'scene'
  AND resource_id   = ANY(ARRAY['scene123', '*'])
  AND resource_sub  = ANY(ARRAY['music',    '*'])
  AND permission_level IN ('edit', 'manage')  -- >= edit
LIMIT 1;
```

一条 SQL 覆盖所有四种路径前缀组合（精确 / 实例通配 / 子类型通配 / 全通配），无需多次查询。

**批量渲染（表格/场景列表）**：不逐字段查询，在请求开始时一次性拉取该用户的全部有效 grants：

```sql
SELECT resource_type, resource_id, resource_sub, permission_level
FROM resource_grant
WHERE production_id = $1
  AND user_id = $user_id
  AND is_revoked = false
  AND (expires_at IS NULL OR expires_at > NOW());
```

结果缓存在请求上下文中，后续所有字段的权限判断在应用层内存完成（O(1) 查表）。Grant 行数通常很少，因为粗粒度 grant（`scene:*:* @ view`）一条覆盖所有场景所有字段。

**索引**：

```sql
-- 主查询索引（替换原 resource_grant_resource_idx）
CREATE INDEX resource_grant_lookup_idx
  ON resource_grant (production_id, resource_type, resource_id, resource_sub, user_id)
  WHERE is_revoked = false;

-- UNIQUE 约束（见 Schema 章节 partial unique index）
-- resource_grant_active_unique_idx 已在 resource_grant 表定义中列出
```

### 资源的域类型

| 域类型 | 含义 | 例子 |
|--------|------|------|
| **dept-managed** | 管理权归部门（平权共管），通过 `resource_grant` 决定访问权，无单一 owner | cue_list、tech_req、note（写）、物料、预算、script_view |
| **creator-owned** | 所有者 = 创建个人，分享是主动行为 | asset（数字资产） |
| **production-wide** | 成员资格即基础访问，演出级别管理 | announcement |
| **event-scoped** | 绑定特定排练/演出场次（基本已被 dept-managed 模型覆盖，暂作预留分类） | — |

### 平权共管模型（dept-managed 资源）

dept-managed 类资源没有单一"owner 部门"，而是由多个部门共同对该资源负有管理责任，称为"共管方"。共管关系记录在 `resource_dept_manage` 表中（结构性关系，不是 grant）。

**关键原则：所有 grant 都是个人 grant，`resource_grant` 表中不存在 dept-level 记录。**

"某部门共管某资源"的含义 = **`resource_dept_manage` 中存在该部门对该资源的记录**，这使得：
- 该部门的 POC 处于该资源 manage 级别的免审批区间（可随时 self-confirm）
- 该部门的普通成员在 `permissions[]` 匹配时处于对应操作级别的免审批区间

**免审批区间（资源权限）**：
- POC：`resource_dept_manage` 命中 → 可 self-confirm manage grant
- 普通成员：`resource_dept_manage` 命中 + `permissions[]` 包含操作 key → 可 self-confirm 对应级别

**审批路由**：查询该资源的个人 manage grant 持有者（`resource_grant`）→ 若无，回退到 `resource_dept_manage` 中各部门的当前 POC → 向所有人发送审批通知（平权，first-action-wins）

**`permission_level` 的语义**：

`permission_level` 是 TEXT 字段，**无 DB 枚举约束**（见 Schema）。

**标准资源**（cue_list、note、script_view、tech_req、物料等）遵循以下线性层级约定（高级包含低级，**由代码约定，非 DB 强制**）：

| 级别 | 含义 | 进入审批链 |
|------|------|----------|
| `manage` | 以上所有 + 审批访问申请、撤销 grant、转移管理权、归档/删除资源 | ✅ 是 |
| `edit` | 以上所有 + 写入/修改资源数据 | ❌ 否 |
| `mount` | 以上所有 + 挂载 asset（附件、参考图等） | ❌ 否 |
| `view` | 读取资源数据 | ❌ 否 |

**有工作流阶段的资源**（event、report）使用资源专属 permission_level 词汇，各级不遵循线性包含关系，由资源代码逻辑单独定义。`manage` 仍是进入审批链的锚点：

| 资源 | permission_level 词汇 |
|------|---------------------|
| `event` | `view` / `edit`（草稿编辑）/ `publish` / `edit_published`（发布后修改）/ `revoke` / `manage`（删除/归档） |
| `report` | `view` / `edit`（草稿编辑）/ `publish` / `edit_published`（发布后修改）/ `revoke` / `manage`（删除/归档） |

tech_req 在标准层级外额外保留 `assign`（分配人员/设备，区别于 `edit` 编辑需求内容）：`view` / `edit` / `assign` / `manage`。

**资源创建时的双写规则**：

资源创建触发两类写入，语义不同：

| 写入目标 | 写入内容 | 触发者 |
|---------|---------|-------|
| `resource_dept_manage`（结构性关系） | 哪些部门对该资源有管理权 | 系统，根据资源类型规则 |
| `resource_grant`（个人 grant） | 创建者本人的 manage grant，`grant_source='self_confirmed'` | 创建行为本身即确认 |

创建者以外的共管部门 POC **不**自动获得 grant——他们处于免审批区间，需要自己点「申请」后立即 self-confirm。

**各资源类型的 `resource_dept_manage` 初始写入规则**：

| 资源类型 | 触发时机 | 写入 `resource_dept_manage` 的部门 | 备注 |
|---------|---------|----------------------------------|------|
| `cue_list` | 新建 cue list | 创建者所在部门 + `allowed_cue_types[]` 匹配的所有其他部门 | |
| `event` | 新建 event | 创建者所在部门 + SM 部门 | 公开 event 同时写全员 `view` grant（`grant_source='auto'`） |
| `report` | 新建 report | 创建者所在部门 + SM 部门 | 正式发布时自动写全员 `view` grant（`grant_source='auto'`） |
| `tech_req`、`note` 等 | 制作人/Owner 手动建立 | 制作人指定的目标部门 | 建立后目标部门 POC 可 self-confirm manage grant |

`allowed_cue_types[]` 语义：控制"哪些部门有资格创建该类 cue list"，并在创建时触发 `resource_dept_manage` 写入。

**POC 变更规则**：
- **新 POC 上任**：不触发任何 grant 写入。`resource_dept_manage` 已存在（部门-资源关系不变），POC zone 自动进入其免审批区间，首次需要操作时 self-confirm 即可。
- **旧 POC 卸任**：触发 `self_confirmed` grant 撤销检查——重新计算免审批区间，对于不再覆盖的 grant 执行撤销（`revoked_reason='poc_change'`）。典型情况：manage 级别的 grant 是通过 POC zone 获得的，卸任后不再覆盖 → 撤销；若该 grant 级别仍在 `permissions[]` 的覆盖范围内（如成员本就有 edit 权限），则保留。

**部门解散规则**：若某部门在 `resource_dept_manage` 中仍有记录，系统**阻止解散**，要求先将这些管理权转移至其他部门（制作人或 Production Owner 直接执行，免审批）。

**新权限**：`resource:grant_manage` — 允许直接给个人写入 `manage` 级 resource_grant，归属于**普通管理**层（制作人默认拥有，无需审批）。

### 资源清单与域归属

| 资源 | 域类型 | 初始共管方来源 | permission_level 词汇 | 当前状态 |
|------|--------|-------------|----------------------|---------|
| cue_list | dept-managed | 创建者部门 + allowed_cue_types 匹配部门 | `view / mount / edit / manage` | ✅ Phase 4 完成 |
| event | dept-managed | 创建者部门 + SM 部门（auto）；公开 event 全员 view | `view / edit / publish / edit_published / revoke / manage` | Phase 5a |
| report | dept-managed | 创建者部门 + SM 部门（auto）；发布后全员 view | `view / edit / publish / edit_published / revoke / manage` | Phase 5b |
| tech_req | dept-managed | 创建者部门（auto on create）；SM 部门有类型级 manage | `view / edit / assign / manage` | Phase 5c |
| note | dept-managed（写）/ production-wide（读） | 创建者部门（auto on create）；SM/导演有 `note:create_any` | `view / edit / manage`；全员有原子 `note:view` | Phase 5d |
| asset（数字资产） | creator-owned | 上传者控制分享目标（`asset_share` 表） | creator-owned 模型，不走 resource_grant | ✅ asset_share 已实现 |
| 物料（实物资产） | dept-managed | 本 epic 范围外，流程待设计 | 待定 | 本 epic 范围外 |
| budget / 财务 | dept-managed | 本 epic 范围外，流程待设计 | 待定 | 本 epic 范围外 |
| script | 原子权限（不使用 resource_grant） | role/dept `permissions[]` 配置 | 原子 key：`script:view / edit_content / edit_marker / annotate / manage_views` | 原子权限已实现；key 整合随各 Phase 资源迁移逐步完成 |
| script_view | dept-managed（resource_grant 独立实体） | 视图创建者（需 `script:manage_views` 原子权限） | `view / edit / manage` | 本 epic 范围外（建议另立计划） |
| announcement | production-wide | 管理员 | 原子权限，不走 resource_grant | 已实现，本 epic 不动 |

### `resource_dept_manage`（部门-资源结构性管理权）

**不是 grant**，是一张结构性关系表，记录"哪个部门对哪个资源实例有管理权"。它是资源权限免审批区间的信号源，不直接放行任何操作。

```sql
CREATE TABLE resource_dept_manage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  dept_id       UUID NOT NULL REFERENCES production_dept(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL DEFAULT '*',   -- 实例 ID；'*' = 该类型全部实例
  resource_sub  TEXT NOT NULL DEFAULT '*',
  established_by UUID NOT NULL REFERENCES app_user(id),  -- 建立关系的操作人
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (production_id, dept_id, resource_type, resource_id, resource_sub)
);
```

**与 `resource_grant` 的分工**：
- `resource_dept_manage`：部门 D 有权管理资源 R → D 的 POC 和成员处于免审批区间
- `resource_grant`：某个具体的人已经确认并持有该资源的某级别权限

### 核心 Grant 表（权限的单一权威）

所有实际权限均来源于两张 grant 表：`resource_grant`（资源权限）和 `atomic_permission_grant`（原子权限）。`grant_source='auto'` **仅用于**加入演出时的 3 条基础 grant；其余所有 grant 均有明确的用户行为作为确认来源。

```sql
resource_grant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  resource_type   TEXT NOT NULL,                    -- 'scene' | 'cue_list' | 'script' | ...
  resource_id     TEXT NOT NULL DEFAULT '*',         -- 实例 ID；'*' = 所有实例
  resource_sub    TEXT NOT NULL DEFAULT '*',         -- 子类型/字段；'*' = 所有子类型
  permission_level TEXT NOT NULL,
  -- 无 DB 枚举约束：标准资源约定 view/mount/edit/manage 线性层级；
  -- 有工作流的资源（event、report）使用资源专属词汇（publish/edit_published/revoke 等）；
  -- task 额外使用 confirm/assign/advance 级；具体语义由应用层代码按 resource_type 定义
  grant_source    TEXT NOT NULL CHECK (grant_source IN (
                    'self_confirmed',  -- 用户主动确认（三级 UX 触发，见「权限确认 UX」章节）
                    'auto',            -- 仅用于加入演出时的 3 条基础 grant（无用户触发行为）
                    'approval',        -- 申请流审批通过后系统写入
                    'direct',          -- 制作人或 Production Owner 直接授权（不走申请流）
                    'assigned',        -- 操作触发型：指定/添加行为本身即授权，接收方无需确认（见「操作触发型 Grant」章节）
                    'migrated'         -- 历史数据回填（backfill script 使用，无操作人信息）
                  )),
  confirmed_by    UUID NULL REFERENCES app_user(id),  -- auto/migrated grant 时为 NULL
  approval_id     UUID REFERENCES approval_request(id) NULL,
  is_revoked      BOOLEAN NOT NULL DEFAULT false,
  revoked_reason  TEXT NULL CHECK (revoked_reason IN ('role_change', 'dept_change', 'dept_dissolved', 'poc_change', 'manual')),
  expires_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

-- partial unique index（取代 CONSTRAINT）
-- 同时排除过期行：过期但未撤销的 grant 不应阻塞同组合的新 grant 写入
CREATE UNIQUE INDEX resource_grant_active_unique_idx
  ON resource_grant (production_id, user_id,
                     resource_type, resource_id, resource_sub, permission_level)
  WHERE is_revoked = false AND (expires_at IS NULL OR expires_at > NOW());
```

`resource_permission_override` 和 `cue_list_permission` 表均归并至此表（Phase 3/4 迁移）。回填 source：`cue_list` 用 `'migrated'`（无从追溯操作人）；event/report/tech_req 有 `created_by` 时用 `'direct'`，`created_by IS NULL` 的行暂缺 manage grant（待 Production Owner 概念落地后补齐）。

> **Schema 权威文件是 `db/schema.sql` 和各 `db/add-*.sql` / `db/migrate-*.sql`，本 PRD 章节仅供设计参考，以代码为准。**

#### `atomic_permission_grant`（原子权限的个人 grant 记录）

与 `resource_grant` 平行的第二张 grant 表，存储原子权限 key 的个人授权记录。

```sql
CREATE TABLE atomic_permission_grant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  permission_key  TEXT NOT NULL,   -- 'script:view' | 'script:edit_content' | 'cue_list:create' | ...
  grant_source    TEXT NOT NULL CHECK (grant_source IN (
                    'self_confirmed',  -- 用户主动确认（三级 UX 触发）
                    'approval',        -- 申请流审批通过后写入
                    'direct',          -- 制作人或 Owner 直接授权
                    'auto',            -- 加入演出时的 3 条基础 grant
                    'assigned',        -- 操作触发型：指定/添加行为本身即授权，接收方无需确认
                    'migrated'         -- 历史数据回填（无操作人信息）
                  )),
  confirmed_by    UUID NULL REFERENCES app_user(id),  -- auto/migrated grant 时为 NULL
  approval_id     UUID REFERENCES approval_request(id) NULL,
  is_revoked      BOOLEAN NOT NULL DEFAULT false,
  revoked_reason  TEXT NULL CHECK (revoked_reason IN ('role_change', 'dept_change', 'poc_change', 'manual')),
  expires_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX atomic_permission_grant_active_unique_idx
  ON atomic_permission_grant (production_id, user_id, permission_key)
  WHERE is_revoked = false;
```

> **两表的结构差异**：两表的 grantee 均永远是个人（`user_id`）。`atomic_permission_grant` 的权限粒度编码在 `permission_key` 中（无 `permission_level`）；`resource_grant` 用 `permission_level` 表达同一资源的多级访问控制。资源权限的免审批区间由 `resource_dept_manage`（部门-资源结构性关系表）决定，**不通过任何 grant 记录**实现。

### 四种权限流程

| 流程 | 触发条件 | grant 创建者 | 用户感知 |
|------|---------|------------|---------|
| **基础自动授权** | 加入演出时，系统自动写入 3 条基础 grant（成员身份、个人档案、演出基本信息） | 系统（`grant_source='auto'`） | 无感知 |
| **三级 UX 确认** | 用户进入演出/编辑界面/总览页（见「权限确认 UX」章节），操作在免审批区间内 | 用户行为触发 → 系统写入（`grant_source='self_confirmed'`） | Level 1：轻量通知；Level 2-A：小型 modal；Level 2-B：顶部 banner |
| **申请流** | 用户发起申请，操作不在免审批区间内 | manage grant 持有者批准后系统写入（`grant_source='approval'`） | 明确感知（申请 → 等待 → 通知） |
| **直接授权** | 制作人/Production Owner 主动发起 | 授权人写入（`grant_source='direct'`） | 被授权方收到通知（被动知情） |
| **操作触发授权** | 执行特定指定操作（将某人加入参演名单、添加为 cue list 协作者等） | 操作触发 → 系统写入（`grant_source='assigned'`），`confirmed_by` = 操作执行人 | 被指定方无感知，可在「我的权限」页查看 |

### 操作触发型 Grant（Assigned Grant）

`grant_source='assigned'` 用于「操作本身即授权」的场景：执行人的操作行为隐含了对被指定人的授权声明，被指定人**无需任何确认**，grant 直接生效。

`confirmed_by` 设为操作执行人（而非被授权人）。区别于 `direct`（制作人单方面授权），`assigned` 强调「把你纳入此事」的操作语义。

**触发规则（当前确认清单，Phase 实现时逐项启用）**：

| 触发操作 | 自动写入的 grant | `confirmed_by` |
|---------|----------------|----------------|
| 将某人加入 event 参演名单（`assign_participants`） | `resource_grant(event, event_id, 'view')` | assigner |
| 将某人加入 event 日程子参演（`assign_schedule_participants`） | `resource_grant(event, event_id, 'view')` | assigner |
| 将某人设为 tech_req 执行人（`assign_tech_req`） | `resource_grant(tech_req, req_id, 'view')` | assigner |
| 将某人显式添加为 cue list 协作者（制作人/POC 操作） | `resource_grant(cue_list, list_id, 'edit')` | creator/POC |
| 将某人添加为某 script_view 的访问者 | `resource_grant(script_view, view_id, 'view')` | view 创建者 |

**撤销规则**：`assigned` grant 不随被指定人的 role/dept 变更自动撤销（因为授权来源是外部指定行为，不是个人免审批区间）。撤销需要操作执行人或制作人手动执行（`revoked_reason='manual'`），或当绑定的资源实例本身被删除/归档时随之撤销。

### 部分授权 UX（字段级权限的前端处理）

资源路径的多级粒度使得同一个页面的不同字段可能有不同权限。API 返回数据时：

- **有 `view` 权限**：返回字段真实值，正常渲染
- **无 `view` 权限**：该字段返回哨兵值 `{"__unauthorized": true}`，前端渲染"禁止预览"状态（🔒），点击可弹出**申请读权限**的对话框
- **有 `view` 但无 `edit` 权限**：字段可见，双击进入编辑模式或提交时触发权限检查，无权限则弹出**申请写权限**对话框

服务端同样在写入时重新校验权限（哨兵值只是 UX 优化，不替代服务端检查）。

UI 只对常见组合做快捷入口（如"申请查看音乐 cue"），底层机制支持任意路径粒度的申请。

### 权限确认 UX（三级触发模型）

权限确认分三个触发级别，按上下文深度递进。所有弹出均仅针对「免审批区间内」的权限；不在区间内的权限一律进入申请流。确认后 grant 永久有效（直到 role/dept 变更触发撤销）。

已持有 `grant_source='direct'/'assigned'/'approval'` 的 grant 不触发任何确认 UI，直接放行。

---

**Level 1：进入演出 → view grant 批量通知**

触发时机：用户进入任意演出页面，检测到有「新的未确认 view 类权限进入免审批区间」时触发（role/dept 变更、加入新部门、新资源归属到所在部门均可触发；所有 view grant 已确认时不触发）。

形式：非阻断式侧边通知或底部 sheet，仅信息告知，无"职责声明"语义。

交互：点「知道了」→ 批量静默写入所有列出项目的 view grant（`grant_source='self_confirmed'`）。关闭 ✕ → 不写入，下次进入时再触发。

```
你可以查看以下内容                        ✕
─────────────────────────────────────
  排演日程
  演出报告（已发布）
  灯光 Cue 表
  ── 新增 ──
  音效 Cue 表              ← 因新加入音响部门

                      [知道了]
```

---

**Level 2-A：进入编辑界面 → edit/manage grant 确认**

触发时机：用户进入具体编辑界面（script editor、dramaturgy editor、character editor、cue list editor、event 编辑页等），且存在未确认的 edit/manage 级免审批区间权限。

形式：小型 modal，有职责声明语义。同一界面内多个权限**合并为一次确认**，不逐权限弹出。

交互：点「确认并开始编辑」→ 批量写入该界面对应的所有未确认 edit/manage grant。

```
你正在进入编辑模式
─────────────────────────────────────
  你在《演出名》中的身份：灯光设计

  在 Cue 表 中，你可以：
  ✓ 编辑 cue 条目（已确认）
  ◎ 管理此 Cue 表（重命名、删除）   ← 本次新增

                [取消]  [确认并开始编辑]
```

---

**Level 2-B：进入资源总览页 → 通配符/创建权限确认**

触发时机：用户进入资源总览页面（event 主页、cue list 总览、report 列表等），且有通配符 view（`resource_id='*'`）或 `create` 类权限进入免审批区间。

形式：页面顶部 inline banner，一行，非阻断。

交互：点「确认」→ 写入通配符 view grant + create 类 atomic grant。点 ✕ → 不写入，下次进入时再触发。

```
作为「舞台监督」，你可以查看所有日程并新建日程        [确认]  ✕
```

---

**典型旅程（以舞台监督为例）**：

```
进入演出
  → Level 1：「你可以查看日程、报告、cue 表」→ 点「知道了」（批量 view grant）
进入 event 主页
  → Level 2-B banner：「你可以查看所有日程并新建」→ 点「确认」
打开某 event 进入编辑页
  → Level 2-A modal：「你可以编辑日程、发布、管理 tech req」→ 点「确认并开始编辑」
此后无任何权限相关弹窗
```

---

**不变的操作确认**（与 grant 无关，每次都需确认）：

| 操作类型 | 确认机制 |
|---------|---------|
| Root / 敏感权限操作 | 每次执行都需 re-auth 或强确认（true sudo） |
| 破坏性操作（删除、归档） | 独立操作确认对话框，grant 已存在也需执行 |

### 访问检查流程

**心智模型**：
- **个人 grant（`atomic_permission_grant` 或 `resource_grant`）是唯一真实权限**
- role/dept `permissions[]` 是原子权限的免审批区间信号
- `resource_dept_manage` 是资源权限的免审批区间信号（部门-资源结构性关系，非 grant）
- 无论何种权限，用户均需主动点击「申请」或执行创建动作来触发授权流程

```
canAccess(user, action, resource):

  步骤 1: 查个人 grant（两张表）
    a. atomic_permission_grant(user_id=user.id, permission_key=action.key, is_revoked=false)
    b. resource_grant(user_id=user.id, resource 匹配, permission_level >= 所需级别, is_revoked=false)
    → 任一命中 → 直接放行

  步骤 2: 未命中
    → 返回"需申请"→ 前端显示「申请」入口，等待用户主动触发

  -- 用户点击「申请」后：

  步骤 3: 检查免审批区间
    a. （原子权限）查 role/dept permissions[] 是否包含所需 permission_key
       → 命中 → 立即写入 atomic_permission_grant(grant_source='self_confirmed') → 放行
    b. （资源权限）查 resource_dept_manage(dept_id IN user.dept_ids, resource 匹配)
       且 role/dept permissions[] 包含对应操作 key（如 cue_list:edit）
       → 两条件均满足 → 立即写入 resource_grant(user_id=user.id, grant_source='self_confirmed') → 放行
       特殊：user 是该部门 POC，且 resource_dept_manage 命中 → 可 self-confirm manage 级别（无需 permissions[] 约束）

  步骤 4: 免审批区间无匹配
    → 进入审批流（通知该资源所有个人 manage grant 持有者；若无，通知 resource_dept_manage 各部门 POC）
    → 批准后写入对应 grant → 放行
```

步骤 3 写入的 grant 的 `grant_source = 'self_confirmed'`；步骤 4 批准后的 `grant_source = 'approval'`。

### role/dept 变更时的 grant 级联撤销

```
成员 role / dept 变更，或 POC 状态变更时：
  1. 重新计算新免审批区间（含 role/dept permissions[]、resource_dept_manage、POC zone）
  2. 查该用户 grant_source = 'self_confirmed' 的所有未撤销 grant
  3. 对比：grant 对应的操作是否仍在新免审批区间内？
     是 → 保留
     否 → 软删除（is_revoked=true, revoked_reason='role_change'/'dept_change'/'poc_change'）
  4. grant_source = 'approval' / 'direct' → 不受影响（明确的人工决策）
```

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
| 跨部门访问 | 分享设置决定 | 待定（本 epic 范围外） |
| 管理员权限 | `asset:view_any` / `delete_any` | `物料:manage_any` |

### 有效权限计算（最小权限模型下的两层结构）

```
第一层：免审批区间（决定用户申请后是否立即通过，还是需要等待他人审批）

  原子权限免审批区间（对应 atomic_permission_grant）：
    = role 权限（production_member_role → production_role_permission）
      ∪ 所在部门公共权限（所有祖先部门 permissions[]，向上遍历）
      ∪ POC 权限（若为 POC：所有子孙部门权限并集 + poc_extra − poc_blocked）

  资源权限免审批区间（决定用户申请后是否立即通过）：
    = resource_dept_manage 中 dept_id IN user.dept_ids 且 resource 匹配的记录
      ∩ role/dept permissions[] 包含对应操作 key（普通成员）
      -- POC 特例：resource_dept_manage 命中即可 self-confirm manage 级别，无需 permissions[] 约束

第二层：实际持有权限（grant 表，是访问的唯一真实依据）
  实际权限 =
    atomic_permission_grant 中有效个人记录（user_id = 本人，未撤销，未过期）
    ∪ resource_grant 中有效个人记录（user_id = 本人，未撤销，未过期）
    其中 grant_source 为：
      'self_confirmed' — 用户申请，在免审批区间内立即通过
      'approval'       — 申请流审批通过后写入
      'direct'         — 制作人或 POC 直接授权
      'auto'           — 仅用于加入演出时的 3 条基础 grant（无任何用户触发行为）

权限检查流程：先查第二层（快，O(1) 索引）→ 未命中 → 弹出申请入口 → 用户点击后查第一层 → 仍未命中则走审批流
```
```

### cue_list 特殊处理

- `production_dept` 新增 `allowed_cue_types TEXT[]` 字段，替代现有 `production_role_cue_type` 表
- 例：灯光部门 → `['lighting', 'followspot']`；音响部门 → `['sound', 'music']`
- 废弃 `CUE_LIST_TEMPLATES.creatorRoles` / `defaultRoles` 的 role 绑定逻辑，改为 dept 绑定
- `cue_list` **不新增** `owner_dept_id`——所有权通过 `resource_dept_manage` 平权共管表达
- 创建 cue list 时，系统写入两类记录：
  1. `resource_dept_manage`：创建者所在部门 + `allowed_cue_types[]` 匹配的所有其他部门
  2. `resource_grant(grant_source='self_confirmed', permission_level='manage')`：创建者本人（创建即确认）
- 迁移：Phase B（见迁移计划）枚举现有演出的 role → dept 映射，手动确认后写入；现有 `cue_list_permission` 回填为 `resource_grant(source='direct')`

### script 权限专项

**访问机制**：script 通过原子权限控制，不使用 resource_grant（script 是演出版本级单例，无 per-instance 分控需求）。

**简化后的原子权限（合并原有细粒度 key）**：

| 权限 key | 含义 | 对应 block_type |
|---------|------|---------------|
| `script:view` | 读取全部 script 内容（content + marker 块） | 所有 block_type |
| `script:edit_content` | 编辑内容块，合并原 `create_block`、`edit_block`、`delete_block`、`set_character`、`set_type`、`set_tag`、`reorder` 等 key | `dialogue`、`stage`、`lyric` |
| `script:edit_marker` | 编辑结构标记块，合并原标记相关 key | `chapter_marker`、`scene_marker`、`rehearsal_marker` |
| `script:annotate` | 添加注释/批注（权限范围小于 `edit_content`，保留为独立 key） | 所有 block_type |
| `script:manage_views` | 创建和管理 script_view 视图（需同时持有 `script:view`） | — |

> 典型归属：编导组的 role/dept permissions[] 包含 `script:view + script:edit_content`；SM 包含 `script:view + script:edit_marker`。成员发起申请后在免审批区间内立即通过，写入 `atomic_permission_grant`。

**行级访问控制：script_view（resource_grant 体系的独立实体）**

需要给特定人员限定可见行（演员只看相关台词、导演为某人策划参考材料）时，使用 `script_view` 而非 per-block grant。

创建视图需同时具备：
- `script:view`（原子权限）：有资格访问剧本内容
- `script:manage_views`（原子权限）：有资格创建和管理视图

视图本身是独立的 resource_grant 资源，有自己的 grant：
- `script_view:view# @ view` → 只能看该视图包含的块
- `script_view:view# @ edit` → 可编辑视图中标记为可编辑的块

**Schema**：

```sql
CREATE TABLE script_view (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  version_id    TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  filter_rules  JSONB NOT NULL DEFAULT '{}',
  -- {
  --   "character_ids": ["c1", "c2"],  -- 含这些角色的 block 自动纳入
  --   "scene_ids":     ["s1"],        -- 含这些场景的 block 自动纳入
  --   "block_types":   ["dialogue"]   -- 特定 block 类型
  -- }
  created_by    UUID NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE script_view_block (
  view_id       UUID    NOT NULL REFERENCES script_view(id) ON DELETE CASCADE,
  block_id      TEXT    NOT NULL,  -- 逻辑 block_id（跨快照稳定）
  override_type TEXT    NOT NULL CHECK (override_type IN ('include', 'exclude')),
  can_edit      BOOLEAN NOT NULL DEFAULT false,  -- 该块在此视图内是否可编辑
  PRIMARY KEY (view_id, block_id)
);
```

视图包含的块 = filter_rules 匹配的块 ∪ 手动 include 块 − 手动 exclude 块。

**访问路径决策树**：

```
需要给某人访问 script？
  ├── 全量访问（编导组、SM 等）
  │     → role/dept permissions[] 包含 script:view + script:edit_content/edit_marker
  │     → 成员发起申请 → 立即通过（免审批区间内）→ 写入 atomic_permission_grant
  │
  └── 受限行级访问（演员、外聘顾问、参考材料）
        → 先给予 script:view（通过 role/dept permissions[] + 申请）
        → 创建 script_view（需持有 script:manage_views）
        → 授予 resource_grant(script_view:view# @ view/edit)
        → 不使用 per-block resource_grant
```

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
查询该资源所有个人 manage grant 持有者（resource_grant 中 permission_level='manage', is_revoked=false）
  ↓
向所有持有者同时发送审批通知（平权，任一人批准即生效）
  ↓
持有者全部超时（ttl_hours 内无响应）→ 升级至共管部门 POC（resource_dept_manage 各部门当前 POC）
  ↓
共管部门 POC 全部超时 → 升级至各部门父部门 POC（逐级向上遍历）
  ↓
所有 POC 层级全部超时 → 升级至制作人（完整升级链兜底前倒数第二层）
  ↓
制作人超时 → 升级至 Production Owner（最终兜底，必然存在）
```

**平权原则**：所有个人 manage grant 持有者同时收到通知，**任一人批准即生效**（first-action-wins）。第一个 approve/deny 后，其余持有者的待处理通知标记为"已由他人处理"，不再可操作。

**First-action-wins 实现要点**：
- 审批 API 使用原子操作：`UPDATE approval_request SET status='approved' WHERE id=$1 AND status='pending' RETURNING id`，无返回则说明已被他人抢先处理，返回 409
- `user_notification` 表须包含 `approval_request_id UUID REFERENCES approval_request(id)` 字段，以支持批量查找同一申请的所有通知并标记状态
- 通知内容模板：批准方处理后，其余通知更新为「[姓名] 已批准 / 已拒绝此申请」，状态改为 `superseded`（新增通知状态值）

**TTL 与升级**：每级通知的 TTL 由 `production_approval_config.ttl_hours` 配置（见 Schema 章节），默认 **24h**，制作人及以上可修改。TTL 内无人响应 → 自动升级至上一级，完整升级链为：

```
资源 manage grant 持有者
  → 共管部门 POC
  → 父部门 POC（逐级向上）
  → 制作人
  → Production Owner（最终兜底，必然存在）
```

TTL 不触发自动拒绝，只触发升级。

**制作人的角色**：制作人**不在第一轮分发通知中**（新申请产生时不通知制作人），只在底下所有层级全部超时后才收到升级通知。收到升级通知本身即意味着部门链路出了问题（所有负责人均未响应），制作人有必要介入了解。此外制作人可随时在 Inbox / 管理后台查看本演出所有 pending 审批并主动介入，无需等待升级。如确实紧急，申请人也可直接联系负责人或制作人走人际通道，由其主动登录处理。

**审批记录**：`approval_request.escalation_chain` 记录每一次升级的时间戳和原因（无 POC / 超时）。

### 可授予的权限组合

所有授权结果统一写入 `resource_grant` 表（grantee 始终为个人 `user_id`）：

| 授权目标 | 授权时限 | 权限级别 | `grant_source` |
|---------|---------|---------|---------------|
| 个人 | 永久 | view / mount / edit / manage | `'approval'`，`expires_at = NULL` |
| 个人 | 限时 | view / mount / edit | `'approval'`，`expires_at = T` |

制作人直接授权（不走申请流）时 `grant_source = 'direct'`，权限级别可达 `manage`，需持有 `resource:grant_manage` 权限。

### 批准后自动执行

审批状态变为 `approved` 时，系统自动写入 `resource_grant`：

```
approval_request.status → 'approved'
  INSERT INTO resource_grant (
    production_id, user_id,
    resource_type, resource_id,
    permission_level, grant_source='approval',
    confirmed_by = resolved_by,
    approval_id = approval_request.id,
    expires_at
  )
```

限时权限查询时 filter `expires_at > NOW()`，不需要主动清理任务。

### 与 #140 的关系

**不是独立新系统**，就是 `approval_request.type = 'resource_access'`，复用同一张表。`approval_request` 需要扩展 resource 相关字段（见 Schema 章节）。

---

## 数据库 Schema

### 新建表

#### `resource_permission_level`（resource_grant 合法 level 的 lookup 表）

```sql
CREATE TABLE resource_permission_level (
  resource_type    TEXT NOT NULL,
  permission_level TEXT NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,  -- 用于 UI 展示权限级别高低
  PRIMARY KEY (resource_type, permission_level)
);

-- Seed（与 add-resource-grant.sql 同步建立）
INSERT INTO resource_permission_level (resource_type, permission_level, sort_order) VALUES
  ('cue_list',    'view',           1),
  ('cue_list',    'mount',          2),
  ('cue_list',    'edit',           3),
  ('cue_list',    'manage',         4),
  ('scene',       'view',           1),
  ('scene',       'mount',          2),
  ('scene',       'edit',           3),
  ('scene',       'manage',         4),
  ('event',       'view',           1),
  ('event',       'edit',           2),
  ('event',       'publish',        3),
  ('event',       'edit_published', 4),
  ('event',       'revoke',         5),
  ('event',       'manage',         6),
  ('report',      'view',           1),
  ('report',      'edit',           2),
  ('report',      'publish',        3),
  ('report',      'edit_published', 4),
  ('report',      'revoke',         5),
  ('report',      'manage',         6),
  ('tech_req',    'view',           1),
  ('tech_req',    'edit',           2),
  ('tech_req',    'assign',         3),
  ('tech_req',    'manage',         4),
  ('note',        'view',           1),
  ('note',        'edit',           2),
  ('note',        'manage',         3),
  ('script_view', 'view',           1),
  ('script_view', 'edit',           2),
  ('script_view', 'manage',         3),
  ('asset',       'view',           1),
  ('asset',       'mount',          2),
  ('asset',       'edit',           3),
  ('asset',       'manage',         4);
```

`resource_grant.permission_level` 通过 FK 引用此表：

```sql
ALTER TABLE resource_grant
  ADD CONSTRAINT resource_grant_level_fk
  FOREIGN KEY (resource_type, permission_level)
  REFERENCES resource_permission_level (resource_type, permission_level)
  DEFERRABLE INITIALLY DEFERRED;
```

**Migration 写作规范**：任何引入新 `resource_type` 的 migration 文件，必须**在同文件里先插入** `resource_permission_level` 行，再建资源表或写 grant 数据，以保证 FK 约束成立。

#### `production_dept`（替代 `event_department`）

```sql
CREATE TABLE production_dept (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id   TEXT NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  parent_id       UUID REFERENCES production_dept(id) NULL,  -- NULL 为顶级部门
  permissions     TEXT[] NOT NULL DEFAULT '{}',              -- 向下继承给子部门成员（免审批区间）
  allowed_cue_types TEXT[] NOT NULL DEFAULT '{}',            -- 本部门有资格创建的 cue 类型（创建时触发 resource_dept_manage 写入）
  -- 部门对资源的共管关系通过 resource_dept_manage 表记录，不在此冗余存储
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
  poc_blocked_permissions TEXT[] NOT NULL DEFAULT '{}',  -- 已包含 poc_block_write_from_children 语义，无需额外字段
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
  entity_id     TEXT NOT NULL,        -- production_id（或 org_id）；无 FK 以兼容 org 级操作，production 删除时应用层显式清理
  subject_id    UUID NOT NULL REFERENCES app_user(id),  -- 申请人

  -- 资源访问申请专用字段（type = 'resource_access' 时非 NULL，DB CHECK 见下方）
  resource_type       TEXT NULL,      -- 'cue_list' | 'script' | 'note' | 'tech_req' | ...
  resource_id         TEXT NULL,      -- 申请的实例 ID；统一用 '*' 表示通配符（与 resource_grant 一致）
  resource_sub        TEXT NULL,      -- 申请的子类型；'*' 表示全部（与 resource_grant 一致）
  permission_level    TEXT NULL,      -- 无枚举约束，与 resource_grant.permission_level 保持一致（含资源专属词汇如 publish/revoke）
  -- 申请人即受益人（subject_id）；制作人主动给他人授权走 grant_source='direct' 直接授权，不经 approval_request
  CONSTRAINT approval_resource_fields_required
    CHECK (type != 'resource_access' OR (resource_type IS NOT NULL AND permission_level IS NOT NULL)),

  -- 授权结果
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'auto_approved', 'disputed')),
  grant_type    TEXT CHECK (grant_type IN ('permanent', 'ttl')) NULL,
  -- 注：不设 'one_time'——一次性访问无误操作缓冲，体验差且无撤销空间
  -- ttl_duration 为审批时用户填写的期望时长；expires_at = granted_at + ttl_duration，以 expires_at 为准
  ttl_duration  INTERVAL NULL,
  granted_at    TIMESTAMPTZ NULL,
  expires_at    TIMESTAMPTZ NULL,

  escalation_chain JSONB NOT NULL DEFAULT '[]',  -- [{approver_id, action, timestamp, reason}]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ NULL,
  resolved_by   UUID REFERENCES app_user(id) NULL
);

-- 按 entity（production）查询 pending 审批的索引
CREATE INDEX approval_request_entity_status_idx
  ON approval_request (entity_id, status, type);
```

#### `production_approval_config`（演出级审批 TTL 配置）

```sql
CREATE TABLE production_approval_config (
  production_id TEXT PRIMARY KEY REFERENCES production(id) ON DELETE CASCADE,
  ttl_hours     INTEGER NOT NULL DEFAULT 24,  -- 每级升级等待时长（小时），制作人及以上可修改
  updated_by    UUID NULL REFERENCES app_user(id),  -- NULL = 从未被人工修改，仍是系统默认
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

演出创建时系统自动插入默认行（`ttl_hours=24`），无需手动初始化。制作人不在自动升级通知链中，但可通过 Inbox / 管理后台查看并处理本演出所有 pending 审批。

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

#### `cue_list`（移除旧权限字段，权限迁移至 resource_grant）

```sql
-- cue_list 不新增 owner_dept_id；共管方通过 resource_grant 表表达。
-- Phase 4 废弃 cue_list_role、cue_list_permission 表，数据回填为 resource_grant 记录。
```

---

## 迁移计划

> **原则**：每个激活最小权限检查的 Phase 必须同时交付对应的 UX（自我确认 + 申请访问入口），不能先上后端、UI 留到最后。

### Phase 0（前置，无代码）
- [ ] 确认 `allowed_cue_types` 枚举值与 `CUE_LIST_TEMPLATES` 的 key 对应
- [ ] 整理现有 role 中助理类职位清单（`ASSISTANT_ROLE_MIGRATION`），准备拆分 migration
- [ ] 确认 `resource_grant` 旧数据回填策略（现有 `cue_list_permission` + `production_member_permission` 如何转换为 grant 记录）

### Phase 1（#158）✅ 已完成（commit ca5e7d7）权限体系基础设施
**实际交付：**
- `add-resource-grant.sql`：新建 `resource_grant` 表（含基础字段）
- `lib/permissions.ts`：新增 `ResourceType`、`PermissionLevel`、`AccessResult` 类型；新增 `canAccess()` 函数（内部回落到 `hasPermission()`，用户无感知）；新增 `DEPT_ASSIGNABLE_PERMISSIONS`
- `MEMBER_BASE_PERMISSIONS` 暂未缩减（保留至 Phase 4 resource_grant 完全接管后执行，确保无 UX 变化）

**与 PRD 目标态的已知偏差（Phase 2c 修正）：**
- `resource_grant` 使用 `grantee_type / grantee_id` 而非 `user_id`
- `permission_level` 沿用旧 3 级 CHECK 约束（`view/write/manage`），`write` 应为 `edit`；未建 FK → `resource_permission_level`
- 缺少 `resource_sub` 列
- `resource_id` 为 NULL（目标态应为 `NOT NULL DEFAULT '*'`）
- `grant_source` 缺少 `'auto'`、`'assigned'` 枚举值
- `resource_permission_level` lookup 表未建
- `atomic_permission_grant` 表未建

**无 UX 变化**

### Phase 2（#137）✅ 已完成（commit ca5e7d7）成员关系模型
**实际交付：**
- `add-production-dept.sql`：新建 `production_dept` + `production_dept_member` 表（空表，数据迁移在 Phase 3）
- `migrate-member-roles.sql`：新建 `production_member_role` FK 表，迁移 `production_member.roles TEXT[]` 数据
- `add-production-member-fields.sql`：新增 `supervisor_id`（含循环引用防护）、`status` 字段
- `add-production-member-tag.sql`：新建 `production_member_tag`（含系统预设 seed）+ `production_member_tag_assignment` 关联表
- `getProductionPermissionContext` 切换为 `production_member_role` FK 查询路径
- Role 变更时触发 `self_confirmed` grant 级联撤销（revoked_reason='role_change'）
- `member-roles.migration.test.ts`：三层 migration 测试

**与 PRD 目标态的已知偏差（Phase 2c 修正）：**
- `production_dept_member` 包含 `poc_block_write_from_children BOOLEAN NOT NULL DEFAULT false` 列（PRD D3 已确认该语义并入 `poc_blocked_permissions[]`，此列不应存在）

**无 UX 变化**

### Phase 2c（架构订正，无 UX）
> **背景**：Phase 1+2 提前实现时 PRD 尚未定稿，导致部分 schema 与目标态偏差。本 Phase 在任何新功能开发前集中修正，确保 Phase 3 起的所有代码可以直接面向正确的 schema 编写。`resource_grant` 表无生产数据，所有变更均为纯 DDL + schema fix。

**后端（文件清单）：**

- `add-resource-permission-level.sql`（add）
  - 新建 `resource_permission_level` lookup 表
  - 插入全量 seed 数据（见 Schema 章节）

- `migrate-resource-grant-v2.sql`（**migrate**，需配套测试文件）
  - 新增 `user_id UUID NOT NULL REFERENCES app_user(id)`（`resource_grant` 无历史行，直接加 NOT NULL 列）
  - DROP COLUMN `grantee_type`、`grantee_id`
  - 新增 `resource_sub TEXT NOT NULL DEFAULT '*'`
  - `resource_id` NULL → `NOT NULL DEFAULT '*'`（`UPDATE SET resource_id = '*' WHERE resource_id IS NULL` 后 ALTER）
  - DROP 旧 `permission_level` CHECK 约束，ADD FK → `resource_permission_level(resource_type, permission_level)` DEFERRABLE INITIALLY DEFERRED
  - 更新 `grant_source` CHECK 加入 `'auto'`、`'assigned'`
  - 重建 `resource_grant_active_unique_idx`（新列，且需排除 expired 行：`WHERE is_revoked = false AND (expires_at IS NULL OR expires_at > NOW())`）

- `add-atomic-permission-grant.sql`（add）
  - 新建 `atomic_permission_grant` 表（完整字段，含 `revoked_reason` 含 `'poc_change'`）
  - 建 partial unique index

- `migrate-dept-member-poc-cleanup.sql`（**migrate**，需配套测试文件）
  - `ALTER TABLE production_dept_member DROP COLUMN poc_block_write_from_children`

**lib/permissions.ts 同步修正（无 DB 变化）：**
- `PermissionLevel` 去掉 `"write"`，改为 `"view" | "mount" | "edit" | "manage"`
- `ResourceType` 补全 `"scene" | "script_view" | "event" | "report" | "asset"`

**测试文件：**
- `tests/resource-grant-v2.migration.test.ts`
  - 层 1（schema）：验证新列存在、旧列已删除、FK 约束存在
  - 层 2（integrity）：`resource_id` 无 NULL 行、`grantee_type` 列不存在
  - 层 3（invariance）：`it.skipIf(!snapshot)`（表无历史数据，快照为空，CI 中自动 skip）
- `tests/dept-member-poc-cleanup.migration.test.ts`
  - 层 1（schema）：验证 `poc_block_write_from_children` 列不存在
  - 层 2/3：无历史数据，基本 schema 验证即可

**无 UX 变化**

### Phase 3（#164 + #163 + event_department 迁移）部门系统
**后端：**
- `add-resource-dept-manage.sql`：新建 `resource_dept_manage` 表（部门-资源结构性管理权，见「资源域权限模型」章节）
- `add-production-approval-config.sql`：新建 `production_approval_config` 表（演出级 TTL 配置），演出创建时自动插入默认行（`ttl_hours=24`）
- `migrate-event-department.sql`：`event_department` / `event_department_member` 数据迁移至 `production_dept` / `production_dept_member`，迁移 `chat_id`
- 部门对资源类型的归属关系通过 `resource_dept_manage` 表达，`production_dept` 无需额外字段
- 废弃 `event_department` 相关 API，新建 `/api/production/[id]/depts` 路由
- 实现部门权限**向下继承**逻辑（父部门 permissions[] 向子部门成员传递）
- 实现 POC 权限计算（子孙部门权限并集 + poc_extra − poc_blocked）
- Dept 成员变更时触发 `self_confirmed` grant 级联撤销（revoked_reason='dept_change'）
- 审批路由算法：平权共管（查该资源个人 manage grant 持有者；若无，查 `resource_dept_manage` 各部门当前 POC；无 POC 则递归向上父部门；最终兜底 Production Owner）
- First-action-wins：任一 POC approve/deny 后，同一申请的其余 pending 通知标记失效
- TTL 升级：超时自动升级至父部门，最终到制作人，再到 Production Owner
- 部门解散前检查：若在 `resource_dept_manage` 中仍有记录则阻止，要求先转移（制作人/Owner 可免审批直接转移）
- POC 冲突处理（祖先/后代关系自动调整，非静默提示）
- `canAccess()` 更新：将 dept 免审批区间纳入计算

**无 UX 变化**

### Phase 4（cue list + 最小权限模型首次对用户可见）
**后端：**
- `add-cue-list-dept.sql`：`production_dept` 新增 `allowed_cue_types[]`（`cue_list` 不新增 `owner_dept_id`）
- 枚举迁移：`production_role_cue_type` → `production_dept.allowed_cue_types`（**操作流程**：在生产服务器上分析现有 role，人工确认 role→dept 映射后，由 migration 脚本按确认结果写入；Phase 0 核对清单中应提前产出此映射表）
- 回填：现有 `cue_list_permission` 和 `cue_list_role` 数据迁移为 `resource_grant` 记录（`grant_source='migrated'`，`confirmed_by=NULL`；不使用 `'direct'`，因历史记录无操作人信息）
- 新建 cue list 时写入 `resource_dept_manage`（创建者部门 + allowed_cue_types 匹配部门）+ 创建者本人的 `resource_grant(grant_source='self_confirmed', permission_level='manage')`
- `canAccess()` 对 cue_list 类型完全切换为 resource_grant 查询（移除 hasPermission 回落）
- 废弃 `cue_list_role`、`cue_list_permission` 表

**UX（与后端同 Phase 交付）：**
- 自我确认对话框：灯光设计首次打开灯光 cue 表 → 确认"你正在以[角色]身份编辑此 cue 表"
- "申请访问"界面：访问不在免审批区间的 cue 表 → 显示申请入口（替代纯 403）
- View 首次访问的轻量通知

### Phase 5 资源迁移（event / report / tech_req / note）

> **排期依据**：Phase 6 审批流的路由逻辑（查 `resource_grant` manage 持有者 → 升级至 `resource_dept_manage` POC）依赖所有资源都已在 `resource_grant` 上；Phase 6（成员管理）的 DELETE 级联撤销也需要 `resource_grant` 覆盖所有资源才完整。因此在成员管理之前完成所有资源迁移。
>
> `script` 不在本 Phase 内（通过原子权限控制，不使用 `resource_grant`，设计已定稿）。`script_view` / 物料 / 财务 超出本 epic 范围，另立计划。

**各资源 PR 拆分（顺序执行）：**

#### PR 5a — event

**后端：**
- `canAccess()` 对 `event` 类型完全切换为 `resource_grant` 查询，移除 `hasPermission` 回落
- 新建 event 时写入 `resource_dept_manage`（创建者部门 + SM 部门）+ 创建者 `resource_grant(self_confirmed, manage)`；公开 event 同时写全员 `resource_grant(auto, view)`
- 回填：现有 `event` 的权限状态转为 `resource_grant` 记录（`grant_source='direct'`，以最近一次显式授权操作人为 `confirmed_by`；无从追溯者 `confirmed_by = production.owner_id`）
- 原子权限清理（折叠进 resource_grant，保留 `*_any` 管理员绕过）：
  - `event:edit / publish / create_schedule / edit_schedule / delete_schedule / assign_participants / assign_schedule_participants / edit_call / view_call_sheet` → `event:event# @ edit / publish`
  - `event:modify_published / revoke / delete` → `event:event# @ edit_published / revoke / manage`
  - `event:create_tech_req / edit_tech_req / view_tech_req / assign_tech_req / delete_tech_req` → `tech_req:req# @ view / edit / assign / manage`（与 PR 5c 协调）
  - `event:*_any` 保留为管理员绕过原子权限
- 将某人加入 event 参演名单 → 自动写 `resource_grant(event, event_id, 'view', grant_source='assigned')`

**UX（与后端同 PR 交付）：**
- Level 2-A modal：进入 event 编辑页时确认 edit / publish grant
- Level 2-B banner：进入 event 主页时确认通配符 view / create grant
- 无权访问 event → 显示申请入口（替代纯 403）

#### PR 5b — report

**后端：**
- `canAccess()` 对 `report` 类型切换为 `resource_grant` 查询
- 新建 report 时写入 `resource_dept_manage`（创建者部门 + SM 部门）+ 创建者 manage grant；正式发布时自动写全员 `resource_grant(auto, view)`
- 回填：同 event，`grant_source='direct'`，无法追溯时 `confirmed_by = production.owner_id`
- 原子权限清理：
  - `report:edit / publish / delete / create_note / edit_note / delete_note` → `report:report# @ edit / publish / manage`
  - `report:modify_published / revoke` → `report:report# @ edit_published / revoke`
  - `report:*_any` 保留为管理员绕过

**UX：**
- 同 event 模式（Level 2-A 编辑确认 / Level 2-B 总览页 banner / 申请入口）

#### PR 5c — tech_req

**后端：**
- `canAccess()` 对 `tech_req` 类型切换为 `resource_grant` 查询（`view / edit / assign / manage` 四级）
- 新建 tech_req 时写入 `resource_dept_manage`（创建者部门；SM 部门有类型级 manage）+ 创建者 manage grant
- 将某人设为 tech_req 执行人 → 自动写 `resource_grant(tech_req, req_id, 'view', grant_source='assigned')`
- 原子权限清理：与 PR 5a `event:*_tech_req` 协调，统一迁移

**UX：**
- Level 2-A：进入 tech_req 编辑/分配界面时确认
- 申请入口替代纯 403

#### PR 5d — note

> **特殊点**：note 读 production-wide（所有成员默认可见），写 dept-scoped。

**后端：**
- `canAccess()` 对 `note` 的写入路径切换为 `resource_grant`；读取路径保持 production-wide（加入演出时自动写 `resource_grant(note, *, 'view', grant_source='auto')`）
- 新增原子权限：`note:create`（本部门 note）、`note:create_any`（跨部门，SM/导演）、`note:view`（production-wide，纳入 `MEMBER_BASE_PERMISSIONS`）
- 新建 note 时写入 `resource_dept_manage`（创建者部门）+ 创建者 manage grant

**UX：**
- note 写入权限：无权限时申请入口（替代纯 403）
- note 读权限：production-wide，无需申请 UI

---

### Phase 6（#165 + #138）标签 + 成员管理 API

> **排期依据**：此时 `resource_grant` 已覆盖所有资源，DELETE /members 的 grant 级联撤销可以完整执行。

**后端：**
- migration：将现有 roles 中助理类复合职位拆分（role=原职位、tag=助理）；复合 role 行保留于 `production_role` 表（不 DROP，避免破坏历史 FK 引用），标记 `is_deprecated=true`（新增 boolean 列）
- 补充标签 CRUD API：`GET/POST/DELETE /api/production/[id]/tags`（系统预设 tag 只读；自定义 tag 限本演出范围；删除自定义 tag 前检查是否有 assignment）
- 重写 `PATCH /api/production/[id]/members` 路由：`supervisor_id`（含循环引用校验）/ `tags`（tag assignment 增删）/ `roles`（切换至 FK 路径）/ `dept`（dept 成员归属变更 + grant 级联撤销）
- `DELETE /api/production/[id]/members/[userId]`：制作人权限检查（`hasPermission("production:manage_members", ctx)` 代理，真正 owner-only 检查待 #137 完整落地）；级联撤销该成员所有 `self_confirmed` grant（`resource_grant` + `atomic_permission_grant`）
- `status` 字段：仅允许管理员通过 PATCH 设置 `suspended`（紧急操作）；`pending_exit / exited` 状态转换保留给 Phase 7 审批流，不在此 Phase 暴露

**UX：**
- 成员详情页展示 tags 和 role（分开显示，复合 role 标注"旧格式"）
- 成员列表支持按 tag 筛选

### Phase 7（#139 → #140 → #141）审批流
**后端：**
- `add-approval-request.sql`：新建 `approval_request` 表（含 resource_access type 及其专用字段）
- Resource access 申请提交 API
- 审批 API（POC 批准/拒绝，first-action-wins）
- 批准后自动写 `resource_grant(source='approval')`
- Member exit 状态机（active → pending_exit → approved/disputed → exited/suspended）
- Owner transfer 双向确认
- TTL 升级计划任务（超时自动通知上级 POC，最终兜底 Production Owner）

**UX：**
- 申请提交后的状态追踪页
- POC 收到申请的通知 + 审批操作界面（Inbox）
- Member exit 申请界面
- Grant 撤销后收到通知

### Phase 8（#156）UI 完整收尾
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

- [x] **「3-5次确认」体验问题**：已通过三级 UX 触发模型解决（Level 1 批量 view grant 通知 + Level 2-A/2-B 分场景合并确认）
- [x] **poc_block_write_from_children 冗余**：已移除，`poc_blocked_permissions[]` 已包含该语义
- [x] **无感 grant / 操作触发型 grant**：已确认 `grant_source='assigned'` 机制，见「操作触发型 Grant」章节；演出策略型（policy）方案已评估后**不引入**（role 模版配置已足够满足宽松授权需求）
- [x] **TTL 时长**：已确认为演出级配置项（`production_approval_config.ttl_hours`），默认 24h，制作人及以上可修改。无演出当天自动降级逻辑（紧急情况走人际通道）。制作人在升级链末端（仅当底下所有层级全部超时后才收到通知），同时可随时通过 Inbox 主动查看并介入全演出 pending 审批
- [ ] **script manage grant 初始化时机**：新建演出后制作人需手动通过 UI 给某个部门建立 script manage grant；是否提供向导式引导（新建演出时询问"哪个部门负责剧本"）？
- [ ] **script_view 实现时机**：script_view 表和相关 API（CRUD 视图、视图内块管理）归入哪个 Phase？建议 Phase 7 UI 收尾时一并实现
- [x] **asset_share 已实现**：asset 分享功能（`asset_share` 表及相关 API）已实现，不在本 epic 计划内
- [ ] **manage grant 的转移 API**：部门解散时的 grant 转移操作，是在部门删除 API 内处理还是独立端点？
- [x] **原子权限申请流的审批路由**：原子权限是类型级操作，无具体实例的 manage grant 持有者作为锚点。审批权上浮至对 `permissions[]` 有配置权的人：**制作人 → 无则兜底 Production Owner**。与 resource_grant 申请路由同一兜底，规则对称。
- [ ] **原子权限清理**（各条目已分配至对应 Phase，随 Phase 完成逐一划掉）：
  - ✅ **Phase 4**：`cue_list:manage_permissions / _any` → resource_grant `manage` 级替代；`cue_list:delete/rename/edit_abbr/edit_description` → `cue_list:list# @ manage/edit`；`cue:create/.../move` → `cue_list:list# @ edit`；`cue:mount` → `cue_list:list# @ mount`
  - **Phase 5a**：`event:edit/publish/create_schedule/.../view_call_sheet` → `event:event# @ edit/publish`；`event:modify_published/revoke/delete` → `event:event# @ edit_published/revoke/manage`；`event:*_any` 保留；`event:*_tech_req` → `tech_req:req# @`（与 5c 协调）
  - **Phase 5b**：`report:edit/publish/delete/create_note/edit_note/delete_note` → `report:report# @ edit/publish/manage`；`report:modify_published/revoke` → `report:report# @ edit_published/revoke`；`report:*_any` 保留
  - **Phase 5c**：`event:*_tech_req` 系列完成迁移至 `tech_req:req# @ view/edit/assign/manage`
  - **Phase 5d**：新增原子权限 `note:create`、`note:create_any`、`note:view`（纳入 `MEMBER_BASE_PERMISSIONS`）
  - **本 epic 范围外**：`script:manage` → `script:manage_views`；`script:create_block/...` → `script:edit_content`；`script:annotate / script:mount` 保留；`asset:mount_any/unmount_any` → resource_grant `mount` level

---

## 明确不在本次范围内

- 组织级（Org-level）的人事管理
- 飞书群组功能的多平台扩展（群组类型搁置）
- 跨演出的成员档案同步
