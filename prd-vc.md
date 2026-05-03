# 剧本-版本

1. 剧本会有多个版本，创建项目时自带一个版本。

2. 版本有四种状态：
   - Editing：编辑中，可编辑
   - Committed：已提交，不可编辑
   - Frozen：已冻结，不可编辑，用于重要锁定节点
   - Archived：已归档，不可编辑，默认隐藏

3. 只有 Editing 版本可以被编辑。

4. 可以基于任意版本创建新版本。

5. 如果基于 Editing 版本创建新版本：
   A(E) => A(C) -> B(E)

   即：
   - 原 Editing 版本自动变为 Committed
   - 新版本为 Editing
   - 新版本继承原版本内容

6. 如果基于 Committed / Frozen / Archived 版本创建新版本：
   A(C/F/Ar) => A(C/F/Ar) -> B(E)

   即：
   - 原版本状态不变
   - 新版本为 Editing
   - 新版本继承原版本内容

7. 版本是单向继承结构。
   - 每个版本最多有一个 parentVersionId
   - 一个版本可以有多个 child versions
   - 不修改历史 parent 关系
   - 不删除历史版本内容

8. 一个版本可以“回退”到它的祖先版本。
   回退不会删除当前版本，也不会覆盖当前版本。
   回退操作会：
   - 先将当前 Editing 版本提交为 Committed
   - 再基于目标祖先版本的内容创建一个新的 Editing 版本
   - 新版本的内容等于目标祖先版本
   - 新版本的 parentVersionId 仍然指向当前版本，而不是目标祖先版本

   例如：
   A(C) -> B(E)
   rollback to A
   =>
   A(C) -> B(C) -> A'(E)

   其中 A' 的内容等于 A，但 parent 是 B。

9. 所有dramaturgy、剧本、cue相关操作都需要选定版本进行

# dramaturgy / scene / character
每个版本全量复制scene/character，引用的地方按照版本正常引用即可，主键由sceneID, characterID转换为(sceneID, ver), (characerID, ver)之类联合主键

# script block
首先需要更新数据库系统
1. 新增主键snapshotID列，blockID不再是主键
2. block-character辅助表中blockID改为snapshotID
3. 新增snapshotID - version relation
4. 实际为了查询方便，relation表可以存blockID
5. 把“sortkey"由主表转到snapshotID - version relation表
6. 基于一个version新增version时仅修改relation表，不修改总表

接下来详细举例解说相关的service
1. insert block (atomic)
snA bl1
snB bl2

snA ver1 1000, ver2 1000
snB ver1 2000, ver2 2000
选择ver2在bl1后插入bl3
snA bl1
snC bl3
snB bl2

snA ver1 1000, ver2 1000
snB ver1 2000, ver2 2000
snC ver2 1500
即查询ver2 bl1的snapshot（snA）, ver2 bl2的snapshot（snB）然后两者sortkey取中间值，且仅关联当前版本
2. delete block (atomic)
snA bl1

snA ver1, ver2
选择ver2删除bl1
snA bl1

snA ver1
即在relation表中存在仍存在snapshot snA的情况下不会真正删除snA，只有在relation表中没有任何snA的reference了才会删除snA
3. edit block (atomic)
snA bl1

snA ver1, ver2
选择ver2修改bl1
snA bl1
snB bl1 <- 分裂

snA ver1
snB ver2
即分裂snA，如果snA已经无法分裂（即只有当前版本有snA）则不分裂
4. split (未必atomic)
split=先insert再edit
5. merge (未必atomic)
merge=先edit再delete

# cue
首先cue也需要更新数据库系统
1. 增加主键revisionID，cueID不再是主键
2. 改变头/尾对于block的引用从blockID变为snapshotID
3. 增加revisionID - versionID relation表
4. 基于一个version新增version时仅修改relation表，不修改总表

cue only业务模式同script block的业务模式1/2/3，但是script block的变化本身会影响cue的处理，详解如下
1. insert block完全不影响
2. delete block
- 情况1:普通引用
snA bl1

snA ver1, ver2

revA cue1 (snA, ...)

revA ver1, ver2
选择ver2 delete bl1
snA bl1

snA ver1

revA cue1 (snA, ...)
revA' cue1 (orphan, ...) <- 分裂，设置部分orphan，mark dangerous

revA ver1
revA' ver2
**针对half orphan**显示为另外半边的point cue，如果是两边ref的是同一个snapshot则会变成双边orphan进入orphan区域
- 情况2:gap引用
假设有连续的两个block
snA bl1
snB bl2

snA ver1, ver2
snB ver1, ver2

revA cue1 (snB[gap], ...)

revA ver1, ver2
选择ver2 delete bl2
snA bl1
snB bl2

snA ver1, ver2
snB ver1

revA cue1 (snB[gap], ...)
revA' cue1 (snA[gap], ...) <- 分裂，向前搜索，mark dangerous

revA ver1
revA' ver2
3. edit block
snA bl1

snA ver1, ver2

revA cue1 (snA, ...)

revA ver1, ver2
选择ver2 edit bl1
snA bl1
snB bl1

snA ver1
snB ver2

revA cue1 (snA, ...)
revA' cue1 (snB, ...) <- 分裂，block内reference进行最短路径匹配，如果不行则标记为index=0，且无论如何均mark为dangerous

revA ver1
revA' ver2



