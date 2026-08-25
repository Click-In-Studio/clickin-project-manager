# 审批流后端能力补齐（2026-08-25）

对应前端提出的缺口清单（`docs/approval-flow-frontend-backend-gaps-2026-08-25.md`）。
本批**零 schema 变更**——链条目在 `approval_request.escalation_chain` JSONB 里，
加字段不需要 migration，因此没有 `db/migrate-*.sql`，也不需要三层 migration 测试。

---

## 1. 链条目新增字段（`ApprovalChainEntry`）

| 字段 | 取值 | 说明 |
|------|------|------|
| `action` | 新增 `"cancelled"` | 这一级**没处理**，申请就被撤回或被新申请顶掉了。此前这种条目上一个动作都没有，前端只能按「等待中」画成灰点，读起来像还挂在那些人手上 |
| `bySystem` | `true` | 该动作由系统发起、**没有操作人**：超时自动升级、被新申请顶掉的旧申请 |
| `cancelReason` | `"by_subject"` \| `"superseded"` | 撤回是本人点的，还是被同目标新申请覆盖的 |
| `comment` | string | 批准 / 拒绝 / 转交 / 撤回时写下的理由，随动作落在这一级上 |

**渲染要点：`bySystem` 与 `actorId` 是两件事。** 判「有没有发生过动作」要看 `action`，
不能看 `actorId`——超时升级恒无 `actorId`。此前 UI 把「升级原因」挂在「操作人」下面渲染，
于是最该说清楚的「没人处理，超时自动升上去了」一个字都显示不出来。

## 2. 终结语义补全

- **撤回**写 `resolved_by`（此前恒 NULL，终结节点上没有人），并把链末条标成 `cancelled/by_subject`。
- **覆盖式申请**顶掉的旧申请同样写 `resolved_by` + `cancelled/superseded/bySystem`。
- `POST .../cancel` 现在回带 `{ ok, request }`，前端不必为拿终态再跑一趟列表。

## 3. 审批 DTO 自带人员信息

`ApprovalRequest.people: Record<userId, { userId, name, roles, isMember }>`，
覆盖申请人、各级候选审批人、操作人、终结者。

- **前端不必再联查 `/contacts`**：那条路拉了全员邮箱手机号只为取个名字，
  而且覆盖不到不在 `production_member` 里的审批人（祖先部门 POC、存量演出的 owner）。
- `isMember=false` = 此人不在本演出成员名单里，但仍是链上真实审批人。
- 姓名口径 `display_name → name`，与通知正文、财务、部门冻结一致。
- 查无此人（profile 行缺失）时该 userId **不出现在 people 里**，消费方自行降级。
- 姓名是**读取时现算**，不是落库快照：改名后历史链会跟着变，这是有意为之
  （2026-08-25 定谳：快照收益撑不起每次升级多查一次名字）。

## 4. 审批意见

`approve` / `reject` / `escalate` / `cancel` 四个接口都接受可选 body `{ comment?: string }`：

- 上限 `MAX_APPROVAL_COMMENT_LENGTH = 500`（`lib/approval-stages.ts`，前后端共用同一个常量）。
- 超长 → **400**，且申请状态一动不动（校验在动手之前）。
- 纯空白按「没写」处理，不在链上留空字段。
- 落在链条目而非独立评论表：这是**审批决定的一部分**，跟着决定走、跟着决定不可变。
  要做多人讨论区是另一回事（要作者、可见范围、附件），那时再单开表。
- 通知正文带上：批准/拒绝进申请人的结果通知；转交说明进**下一级**审批人的待办通知
  ——不带的话「由上一级转发」是一句没有信息量的话。
- 旧客户端不发 body 照常工作（`req.json().catch(() => ({}))`）。

## 5. 提交前的审批链预览

`GET /api/production/:id/access-requests/preview?resourceType=&permissionLevel=&resourceId=&resourceSub=`

```jsonc
{
  "nodeClass": "normal",       // root = 无审批通道；sensitive = 跳过整条链直达 owner
  "stages": [{ "stage": "supervisor", "depth": 0, "canFinalize": false, "approverIds": ["…"] }],
  "people": { "…": { "userId": "…", "name": "直属上级", "roles": [], "isMember": true } }
}
```

- **这是预测不是承诺**：阶梯按此刻的汇报关系/持有者/POC 现算，提交后每次升级都会重算。
  中间任何人事变动都会让实际链路与预览不同——UI 必须呈现为「预计」。
- `subjectId` 恒取 session，不接受入参：阶梯本身就是一张组织关系图，谁的链谁能看。
- `nodeClass` 是这个接口的另一半价值：ROOT 节点提交时会被 `no_entry` 拒收，
  让人填完整张表才吃 403 是白填；预览一眼就能说清「这个权限没有申请通道」。

## 6. 阶梯文案单一来源：`lib/approval-stages.ts`

级名、阶梯序、动作词、治理域提示、意见长度上限都在这里，**该模块不 import pg，
client component 可以直接引**。此前这些常量埋在 `lib/db.ts` 与 `lib/approval-routing.ts`，
两个文件都碰数据库，前端只能自己抄一份，抄完就漂——同一级在飞书通知里叫「资源持有者」，
在页面上叫「资源持有人」。

前端请直接用：`APPROVAL_STAGE_LABELS`、`approvalStageLabel(stage, depth)`、
`APPROVAL_ACTION_LABELS`、`APPROVAL_NODE_CLASS_HINTS`、`MAX_APPROVAL_COMMENT_LENGTH`。

---

## 仍未建模（前端不要画）

抄送节点、处理节点、指定人转交、退回、会签/或签、跨业务统一收件箱。
这些要节点类型 + 节点策略的模型改造（`nodeType`、`any/all/sequential`），是独立工程。

**当前的多人节点语义是「或签」**：同一级任一有权人操作即完成该级
（收件箱与鉴权都只读 `current_approver_ids`，谁点谁算）。并排展示多人时请写明
「任一人处理即可」，否则会被读成需要全员批准。

## 已有但前端尚未使用的字段

`grantedAt` / `expiresAt` 早就在 DTO 里。批准后画一个「已发放权限（有效期至 …）」节点，
「审批 ≠ 办结」这个语义立刻就有真实落点，零后端成本。
