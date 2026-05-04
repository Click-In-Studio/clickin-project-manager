# Assets 附件功能
采用Cloudfare R2+ECS/EBS缓存+飞书链接的混合模式
1. Cloudfare R2
    - Dev Bucket click-in-test
    - Prod Bucket click-in
2. ECS/EBS
    - 可以创建一个文件夹
    - 这个文件夹将来会被ln到另一个地方
3. 飞书链接
    - 提供飞书node链接
    - 储存链接即可
存储模式：
上传文件默认去R2，如果上传的是图片类型，在ECS/EBS的文件夹缓存缩略图

## Assets的元数据
1. 用途类型（可简单配置，当前进行非穷尽罗列）
    - 图纸：drafting
    - 平面图：planogram
    - demo
    - 排练视频
    - reference
    - 素材
    - 片段
    - qlab
    - 乐谱
    - 录音
2. Mime类型
3. 挂载点 - 多对多（即一个asset可以挂载到多个点上），需要创建辅助表，有一些挂载点可能单独看比较迷惑但是结合版本控制就不会迷惑了
    - production挂载点，需要使用简单目录结构进行管理
    - version挂载点
    - scene挂载点 (scene only)
    - scene snapshot挂载点 (scene+version)
    - block挂载点 (block ID)
    - block snapshot挂载点 (snapshot ID)
    - cue挂载点 (cue ID)
    - cue revision挂载点 (revision ID)
    - comment挂载点(comment ID)
    - event挂载点
    - 事件日程挂载点
    - 事件技术需求挂载点
    - 事件报告挂载点

## Asset的权限控制
- 每个人对挂载点本身对访问权限=对于asset的读权限
- asset上传人有对asset对修改、删除权限
- asset上传人有查看自己上传的asset的权限
- asset上传人有挂载自己asset的权限（只能挂载到自己有权限**查看**的地方，不需要修改权限，例：作曲没有修改dramaturgy的权限但是仍然可以往scene挂载点挂音频demo）
- 管理权限有查看全局asset、对asset修改、删除的权限
**查看全局asset**指在一个统一界面查看所有挂载或为挂载的asset信息

## Asset的版本管理
- asset的挂载点分为版本相关挂载点和版本无关挂载点
    - 所有涉及版本控制的元素的挂载点为版本相关挂载点
    - production挂载点、comment挂载点、事件xx挂载点为版本无关挂载点
- Asset 有两层 ID：
  - assetID：稳定资产身份
  - assetVersionID：具体文件版本

- 版本相关解析通过 assetVersionID - versionID relation 完成。
  - AssetCoveredVersions(assetID) 指该 assetID 能解析出 assetVersion 的所有 script version 集合。
  - 读取版本相关挂载点时，通过 assetID + currentVersionID 解析 assetVersionID。

- asset可以由用户选择无版本概念，这个情况默认单个assetVersionID覆盖所有版本，可以特殊标记，不参与assetVersionID - versionID relation

- 上传创建asset时默认asset是全版本通用的，但是可以上传对应版本的asset (version only)或者对应版本之后的asset (version tracking)。创建新版本时会fork当前版本的assetVersion，不创建新的assetVersion仅填写relation表。

- 挂载asset至版本相关挂载点有三种模式
    - 继承(inherit)模式：
        实际挂载点：stable ID，如blockID, cueID, sceneID
        限制：asset出现的所有版本必须覆盖stable ID出现的所有版本、stable ID覆盖的版本不能有冻结的版本
    - 跟踪(tracking)模式[默认]:
        实际挂载点：snapshot ID，revision ID
        限制：asset出现的所有版本必须覆盖snapshot在当前选中版本之后的所有版本
        处理：
        a. 对于snapshot，要分裂快照并且如果有需要的话分裂快照挂载的cue revision（参考prd-vc.md的cue部分的第三点）即等价于edit snapshot
        b. 对于cue，要分裂cue revision，等价于edit cue
        c. 对于scene以及production，无法进行tracking挂载
    - 当前（version only）模式：
        实际挂载点：snapshot ID，revision ID，(scene ID+version ID), version ID
        限制：asset出现在当前版本
        处理：
        a. 对于snapshot，需要做完全分裂，即断开前、后的所有连接，需要注意维护cue revision的一致性
        b. 对于cue，也要做完全分裂，即断开前、后的所有连接
        c. 对于scene以及version，直接挂载即可

- 挂载asset至版本无关挂载点
    - 评论/事件xxx挂载点
    让用户选定版本或使用无版本asset，绑定assetVersionID
    - production挂载点
    询问用户以区分以下两种情况
    a. version-resolved版本跟随: 绑定assetID, 显示版本跟随用户当前选择版本
    b. global全局: 让用户选定版本或使用无版本asset，绑定assetVersionID，即使用一个具体的asset作为global domain使用


## 特殊注意
- 在所有snapshot分裂/cue revision分裂事件中注意维护asset挂载点，如果挂载点为snapshot/revision会自动增加挂载点