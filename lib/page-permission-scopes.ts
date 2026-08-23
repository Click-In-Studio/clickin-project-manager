type Permission = string;

/**
 * Per-page permission scopes for the self-confirm gate.
 * On entry to each page / context, we check if the user has any selfConfirmable
 * permissions in the relevant scope and prompt a one-click activation.
 *
 * `base` handles the Level 1 view-grant notification (see AppShell):
 * after #158 removed the MEMBER_BASE_PERMISSIONS bypass, view-class perms
 * go through the same role→selfConfirm→grant path as all other permissions.
 *
 * ─── 两条编入规则（2026-08-17 教训）──────────────────────────────────────────
 *
 * 1. **门票键必须进 base。** 每个页面的 view 门跑在 redirect 之前，而
 *    PageActivationGate 在页面 JSX 里——进不去页面就见不到该页的激活弹窗。
 *    所以「进页面的门票」（各域 meta@view / blocks@view）一律挂 base
 *    （AppShell 全局渲染），页面 scope 只放进去之后才用得上的写类能力。
 *
 * 2. **只放判定端真实消费的键。** 激活面的职责是把区间落成 grant 行；落一个
 *    没有任何门去查的行，等于在弹窗里让用户勾选一个不存在的能力。模板
 *    （lib/templates/*.ts）发了但判定端没门查的键属于另一类欠账（模板 > 判定的
 *    粒度差），不在这里补齐。
 *
 * 批D/E 把 script/dramaturgy/characters/assets 清空后只删不填，整条自确认管道
 * 里没有这些域的键 → 弹窗永不出现、区间永远变不成行，全库 33 人被冻结在迁移
 * 那一刻。tests/activation-scope-coverage.test.ts 是防止复发的棘轮。
 */
export const PAGE_PERMISSION_SCOPES = {
  base: new Set<string>([
    // 批A：cue 域读权限改为树节点键（node:<type>/<id>[/<sub>]@<verb>）
    "node:cue_list/*/meta@view",
    "node:cue_list/*/cues@view",
    "node:cue_list/*/cues/comments@create",
    // 批B：event 域读取+订阅（原 event:follow 两职拆分）
    "node:event/*/meta@view",
    "node:event/*/details@view",
    "node:event/*/followers@create",
    // 批E：剧本页门票（script/page.tsx 的 redirect 门）
    "node:script/*/blocks@view",
    // 批E：场次目录门票（dramaturgy / scenes 页的 redirect 门）
    "node:scene/*/meta@view",
    // 批E：角色目录门票（characters 页的 redirect 门）
    "node:character/*/meta@view",
    // 批D：附件门票（assets 页 redirect 门 = meta@view；file@view = 下载/原件）
    "node:asset/*/meta@view",
    "node:asset/*/file@view",
    // 批F：通讯录门票。contacts 页没有自己的 PageActivationGate，全靠 base
    // 这一层——挂在 AppShell 上，进任何页面都能激活。
    "node:member/*/meta@view",
    "node:member/*/contact@view",
    // 批F：公告 / 里程碑。读面是全员门票；写面（制作助理模板）也放这里——
    // 这两个域散在 announcements / planning / admin 三处页面，与其挂三个
    // scope 不如收在 base，反正判定端是演出级 CRUD 而非实例面。
    "node:announcement/*@view",
    "node:announcement/*@create",
    "node:announcement/*@edit",
    "node:announcement/*@delete",
    // 财务页不设门（进得了项目就进得了），但这两枚是它的内容票：科目表只读面
    // 与「填报销单」。跟 material/*@view 一样挂 base——AppShell 全局渲染，
    // 页面自己没有 PageActivationGate 也能激活。
    "node:finance/*/categories@view",
    "node:finance/*/expenses@create",
    "node:material/*@view",
    "node:milestone/*@view",
    "node:milestone/*@create",
    "node:milestone/*@edit",
    "node:milestone/*@delete",
    // phase 与 milestone 平级同规范（读面全员门票；写面统筹位），同收 base
    "node:phase/*@view",
    "node:phase/*@create",
    "node:phase/*@edit",
    "node:phase/*@delete",
  ]),

  // 批E-2：剧本页写面。blocks 写是一把总钥匙（requiredPermissions 对 insert /
  // update / delete 统一给 blocks@edit）；标签组的 picker 也在剧本页内。
  // imports 是保留段（'*' 不覆盖），必须显式列出才可自确认。
  script: new Set<Permission>([
    "node:script/*/blocks@edit",
    "node:script/*/comments@create",
    "node:script/*/rehearsal_marks@create",
    "node:script/*/mounts@create",
    "node:script/*/imports@create",
    "node:tag_group/*@create",
    "node:tag_group/*@edit",
    "node:tag_group/*@delete",
    "node:tag_group/*/options@create",
    "node:tag_group/*/options@delete",
  ]),

  // 批E-1：构作页写面。字段写挂 meta 下（总表 §0「字段写权限挂 meta 下」）——
  // 判定端逐字段查、模板端逐字段发，两侧键一一对应。scene/*@edit 是结构面
  // （场次重排、块的归属变更），与字段写分开。
  dramaturgy: new Set<Permission>([
    "node:scene/*@create",
    "node:scene/*@edit",
    "node:scene/*@delete",
    "node:scene/*/meta/name@edit",
    // meta/number 无判定端消费者——场次号由 marker 顺序自动派生，没有改号入口
    "node:scene/*/meta/type@edit",
    "node:scene/*/meta/expected_duration@edit",
    "node:scene/*/synopsis@edit",
    "node:scene/*/action_line@edit",
    "node:scene/*/music@edit",
    "node:scene/*/stage_notes@edit",
    "node:scene/*/mounts@create",
    "node:dramaturgy/*/imports@create",
  ]),

  // 批E-1：角色页写面。character 的编辑是整实例一把钥匙（characters/[charId]
  // 路由的真相），没有字段级门——故此处不列字段键。
  characters: new Set<Permission>([
    "node:character/*@create",
    "node:character/*@edit",
    "node:character/*@delete",
  ]),

  // 批A：cue 域激活面全部走树节点键。集合 create 是唯一需要页面级激活的
  // 生产级能力；每表写权限由 CuePage 的 per-list access 流处理（zone self-confirm）。
  cuelists: new Set<string>([
    "node:cue_list/*@create",
  ]),

  events: new Set<string>([
    // 批B：事件管理激活面（原 event:create/view_call_sheet_any/task:* 原子键）
    "node:event/*@create",
    "node:event/*/chat@create",
    "node:event/*/call_sheet@view",
    "node:task/*@view",
    "node:task/*@delete",
    // 批B 遗漏补齐（2026-08-17）：舞台监督/助理舞台监督模板发了这五枚，判定端
    // 也都有门（发布=publication@create、撤回=@delete、提前看 draft=@view、
    // event 整树 view、事件下报告可见），但激活面从没收——与编剧拿不到
    // blocks@view 同一个病。
    "node:event/*@view",
    "node:event/*/publication@view",
    "node:event/*/publication@create",
    "node:event/*/publication@delete",
    "node:event/*/reports@view",
    // #236：报告删除键同时挂 events scope——舞监的日常在事件页，从事件进报告时
    // 不一定路过 /reports 列表页。同一个键出现在两个 scope 是允许的（激活面按
    // scope 取交集弹窗），这样两条路径进来都能一键激活。
    "node:report/*@delete",
  ]),

  reports: new Set<string>([
    // 批C：报告挂接与评论管理走树节点键
    "node:event/*/reports@create",
    "node:report/*/replies@create",
    "node:report/*/replies@edit",
    "node:report/*/replies@delete",
    // 批C-3 遗漏补齐（2026-08-17）：导演模板的 notes 通配（dept 首次成为树上
    // 资源类型），判定端在 lib/event-permissions.ts 有门
    "node:dept/*/notes@create",
    // #236 张力 4a/4c（2026-08-18）：报告 DELETE 门改查 delete 动词后，
    // node:report/*@delete 成为舞监的默认持钥键——模板发它，激活面就必须收它，
    // 否则舞监永远激活不出行（激活面断层，见《权限系统-激活面断层与scene编辑权限失效》）。
    "node:report/*@delete",
  ]),

  wiki: new Set<string>([
    // wiki 文档库 W2：文档创建（实例面 view/edit 走分享/挂载推导，不设页面激活）
    "node:wiki/*@create",
  ]),

  // 批D：附件页写面。上传后的十行由创建者行集自动发（§0.9 C-5），此处是
  // 「能上传」与「能发分享令牌」两项能力本身。
  assets: new Set<Permission>([
    // 新建素材条目。四条上传路由（route / presign / presign-part / presign-multipart）
    // 查的都是 asset/*/*@create，而此前激活面只列了下面那枚 file@create（那是「给已有
    // 素材加新版本」的门，app/api/.../assets/[assetId]/files）——两枚是不同的门，
    // sub 不同互不命中。缺这一枚的后果：部门/角色拿到上传区间也永远激活不出行。
    // 由项目模版的部门静态行（asset/*@create）触发棘轮暴露（#163）。
    "node:asset/*@create",
    "node:asset/*/file@create",
    // 改素材元数据（重命名 / 归档 / 补信息）：门在 assets/[assetId] 的 PATCH，
    // 查 asset/<id>/meta@edit。与上面那枚同源的洞——此前没有任何角色/部门持有它，
    // 故一直没人撞上；音乐类的「音乐制作」要做素材整理，需要它可激活。
    "node:asset/*/meta@edit",
    "node:asset/*/shares@create",
  ]),
} as const;

export type PageScope = keyof typeof PAGE_PERMISSION_SCOPES;
