# Node 树统一设计（asset/wiki 融合）——2026-09-04 定谳

> 本文是 asset 结构重梳理的设计定谳，源于 #85（资产更多信息显示）的前置讨论。
> 结论：#85 的元数据基建与本工程**正交、可先行**；树化是独立 epic。

---

## 0. 一句话图景

一棵 node 树（wiki 文档 + asset 壳节点）承载**组织与权限**；异构的业务边承载**消费关系**（挂载/引用），遵守统一的 node 侧契约；实体上下文里出生的内容沿**出生链递归**落进归档文件夹。

## 1. 动机

1. **统一心智模型**：wiki 已有树 + 软链接 + 引用边的完整体系（W0-W5、#358 alias、#303/#304 entity_link）；asset 是 flat + 挂载点。两套模型合一。
2. **融合**：asset 穿插进 wiki（飞书式）。基建已预埋——`wiki_alias.target_type` 注释明写 `'asset' 等待接入`（schema.sql:781）。
3. **组织能力**：flat 资产库无法承载交付批次场景（如混音师交付 20 个数十 GB 的 ADM BWF，每个都是需要独立 QC/引用的一等交付物）。
4. **AI 前置**：asset 接入 AI 需要可查询的组织结构与元数据。

## 2. Node 树

**飞书式壳节点模型**：树节点是壳（位置 + 权限），内容对象另存。

- wiki 节点：壳 + 正文（现状不变）。
- asset 节点：壳挂 `asset_id` 指向 `asset` 表；`asset`/`asset_file` 继续管文件版本、R2 key、share token。asset 节点是资产的 **canonical 家**（区别于 alias 的"第二位置"）。
- 权限：asset 节点继承 wiki 树语义——`listable` 沿祖先链求交（不物化）、`is_public`、grant、dept_share。**定谳等价关系：原 `production` mount ≡ "节点在树上且可枚举"**，因此该 mount 类型退役，无需任何边。
- 存量迁移：全部资产 backfill 壳节点，挂到人人可枚举的「资产」根下，行为不变。
- 软链接：`wiki_alias` 按预留接入 `target_type='asset'`，资产可在树中有多个位置（叶子、零权限、读时 join 目标）。

实现选择（待实现期定）：扩展 `wiki` 表为 node 表（加 kind + target 指针，UUID PK 存量不动）vs 新建 node 表迁移 wiki——倾向前者，迁移成本低。

## 3. 边体系：异构边 + 统一契约

**挂载边是一种关系概念，不是一张表。** 不同业务的边有不同特性（列、元数、语义），各自建表、各归业务域所有：

- 现存：`asset_mount`（→演化为 `node_mount`，见 §4）、`wiki_entity_link`、`wiki_alias`、`mentions`。
- 将来：report 的 `<report, dept, note>` 三元边、角色-卡司的 `<character, member, node>`（量体数据 wiki、定妆照 asset）等，按需生长。

**否决宽统一边表**：现场证据即 `asset_mount` 自己——14 个 `mount_type` 值中 4 个是版本时代化石，`mount_mode`/`version_resolved` 整列是化石。统一表 = 化石放大器 + invariant 靠注释 + 迁移热点。

**Node 侧契约（任何边种必须遵守）**：

1. **寻址**：边以 node id 指向节点；node 侧不知道有哪些边种。
2. **悬空即删**：读路径 join 目标，解析不到不出现，不做失效占位（同 `wiki_entity_link` 悬空边容忍定式）。无版本迁移概念——版本体系已淘汰，只有 head，边即对最新状态的挂载。
3. **边不投权限票**【硬不变量】：权限只由 node 侧判（祖先链 + grant）。成员定向可见性表达在 node 的 grant 上，不得写进边语义。（同 wiki 边零权限、supervisor_id 只路由不授权的既有纪律。）

**跨边种反查（resolver 注册表）**：边去中心化后，"该 node 被谁引用"由应用层注册表回答——每边种注册一个 `(nodeId) → 引用方列表` 查询函数。服务删除保护（"仍挂在 3 个 cue 上"）、node 详情"被引用处"面板、AI 问答。不物化反查表（同"判定时现查、零 sweep"的仓库风格；N 个索引点查 UNION 廉价）。

## 4. `asset_mount` → `node_mount`

"简单通用挂载"作为**缺省边种**保留，`asset_mount` 原地演化：

- `asset_id` → `node_id`（红利：wiki 节点从此也能挂到 cue/event/task）。
- 化石清理（真 migration，走 `migrate-*.sql` + 三层测试）：删 `mount_mode`、`version_resolved`；退役 `mount_type` 的 `version`/`scene_snapshot`/`block_snapshot`/`cue_revision`；`folder_path` 移交树（存量数据去向待迁移设计时定）。
- **退役两个 mount 类型（定谳）**：`wiki`（被树位置/alias/正文嵌入取代）、`production`（≡ 可枚举 node，见 §2）。
- 瘦身后形状：`<mount_type, mount_id, mount_aux_id?, node_id, created_by, created_at>`。
- **毕业模式**：业务复杂度到了就从 `node_mount` 毕业成专表（带自己的列/逻辑，登记 resolver）。通用边与特化边是生命周期两阶段，非二选一。

## 5. 缺省落点：业务上下文新建的内容自动放进树的哪里

问题的人话版：舞台监督对着排练直接传视频、在 event 里建 report——这些内容不是在树里手动选位置建的，那它们的 canonical 家缺省落在哪？答案：自动落进该实体对应的文件夹。挂载边（业务点能看到它）与树落点（库里放在哪）在创建事务中各建各的，之后独立演化。

- **惰性 get-or-create**：归档夹在实体首次有内容时创建；节点带 `(entity_type, entity_id)` 指针 + 唯一约束，后续上传按指针找回（无论被挪去哪）。
- **名字实时跟随**：存指针不存副本，渲染时 join 实体（复用 alias `display_title NULL=跟随` 定式）；实体删除时一次性把名字冻进 `display_title`。
- **递归规则**：归档夹落在其实体出生上下文的归档夹里。出生链 event → report → note 产生 `events/<event#>/<report#>/<note#>`。这不是镜像业务组织结构（不抄 event group/演出季），是同一条 get-or-create 规则的递归应用。
- 缺省落点不是监狱：用户可把内容挪进自己组织的目录，归档夹按指针仍可找回。

## 6. report/notes

- report/notes 进树：report 文档节点缺省落 `events/<event#>/<report#>` 并挂载到 report 实体；note 缺省落 `.../<note#>` 并以 `<report, dept, note>` 三元边挂载（note 按部门关联，读取路径走边，树只管家在哪）。
- **待拍板**：report 双面（`event_report` 业务表管回执/结构 + 树节点管内容，边相连）vs 全节点化（回执等变 node 附属表）。倾向双面（存量不动）。

## 7. 明确不做

- ❌ **业务实体进树**：event/scene/cue 不是树节点（镜像必漂移；飞书也不做）。树里只有它们的**归档文件夹**（指针节点）。
- ❌ **挂载 = 树位置**：挂载是 N:M 引用（一个音效挂 5 个 cue），树位置是 1:1 包含。两问题正交：树答"库怎么组织"，边答"哪个业务点用什么"。
- ❌ **宽统一边表**（§3）。
- ❌ **文件夹上传作为新 bundle 实体**：批量上传 = 对 N 个文件循环现有单文件 presign/multipart 流程（天然每文件独立续传）+ 落进树上同一文件夹。无新存储模型。
- ❌ 新设计考虑版本迁移（版本体系已淘汰，只有 head）。

## 8. 与 #85 及长尾的关系

#85（元数据基建 + zip parser）挂在 `asset_file` 上，与组织结构正交，**可并行/先行**。要点（另见 #85 讨论）：

- `asset_file.metadata JSONB` 存摘要 + R2 sidecar `meta/<fileId>.json` 存大结构；envelope `{parser, parserVersion, parsedAt, summary}`；immutable key ⇒ 缓存永不失效，parserVersion 是唯一重算触发器。
- 懒生成（照 `lib/avatar-serve.ts` 模式）+ 上传后 fire-and-forget 踢一脚；存量免 backfill。
- parser 输入是**可 range 读的字节源**抽象（顶层文件 = R2 range；zip 内 entry = range + inflate 单 entry——zip 逐 entry 独立压缩，取包内单文件不用碰整包）。
- mime 不可信（客户端上报），按扩展名 + magic bytes 分发。
- zip 递归 v1 只解一层，嵌套包显示为"未展开"节点。

**Issue 顺序**：树化 epic →（依赖树）批量上传 → 交付配对 QC（ADM ↔ stereo variant 时长/采样率比对）。并行：#85 → 包内单文件取用/预览 → wav(ADM/BWF)/als/qlab/musicxml/midi 等 parser 长尾 → promote（包内文件提升为独立资产）→ 工程引用完整性校验（als 引用 ↔ 包内文件交叉验证）。

## 9. 待拍板清单

1. **资产页 UI 何去何从**：统一后独立资产页与文档树页是什么关系（合并？资产成为树页里的一类节点 + 过滤视图？）——独立设计子项，不是仿照 wiki 页复刻一个树化资产页。
2. report 双面 vs 全节点化（§6，倾向双面）。
3. 实体文件夹被挪进私密子树后的立场（倾向：谁挪谁负责 + 上传成功 UI 明示落点）。
4. node 表实现：扩展 `wiki` 表 vs 新表（倾向扩展）。
5. `folder_path` 存量数据去向。

## 10. Epic 边界与复杂度

- **Epic 内，第一批（原子迁移）**：树化主体 + 挂载边迁移（node_mount migration + resolver 反查 + report/notes 边改造——三者是同一个子项目）。两件互相依赖必须一起落地：边改指 node_id 需要壳节点已存在，壳节点建好而边仍指 asset_id 则两套寻址并存——都是半迁移态。
- **Epic 内，第二批（可以慢慢来）**：资产页 UI 去向、缺省落点。缺省落点过渡期无压力：现有缺省行为继续用，没有落点的暂放 root 慢慢补。
- **Epic 外（依赖本 epic）**：批量上传、交付配对 QC。#85 正交可并行。
- **复杂度**：逻辑本身简单——树/alias/边零权限/悬空容忍的基建 wiki 侧全部已有，asset 是接入方不是新造方；工作量集中在迁移细节（化石清理、存量 backfill、mount 语义转译）。

## 11. 第一批实现修正记录（2026-09-04 实施时定谳）

- **`block_snapshot`/`cue_revision` 非化石**（设计误判修正）：它们是当时的默认
  写路径，迁移做了数据转译（→ 稳定 `block_id` / `cue.cue_id`），随之删除
  lib/db.ts 的 11 处 CoW/GC 挂载复制与 `cow*ForMount` 两函数。真化石只有
  `version`/`scene_snapshot`（零写入者）。
- **漂移一不接受**（拍板 6）：枚举面谓词对 asset 节点只认 `listable ∨ dept_share`，
  不析取 asset 实例 grant——定向分享的私有资产不因此进树，行为与迁移前全等。
  漂移二接受（缺能力票的成员在树里见共享资产标题，内容面拦截）。
- **download-url/preview-url 补 `canViewAsset(file)` 门**（原先任何成员可下载任意
  资产的洞，随本批修复，属收紧）。
- **proposal 面协议与存储解耦**：`wiki_proposal.parent_node_id` 存 node id，
  对外接口维持 AI 方言协议的 wiki id（proposal-db 读写各翻译一次）。
- **grant 行一行未迁**（验证成立）：`*@view`⇒`meta` 蕴含、WIKI_LEVEL_ROW_SETS、
  `node:wiki/<id>@…` 键字符串全程零改动，invariance 测试逐字节断言。
