# 审批流程模板 UI 与后端缺口（2026-09-02）

## 结论

本轮页面此前显示的“发起 → 当前节点”既有演示数据不足，也有产品模型差异：

1. `scripts/seed-local-demo.ts` 原来只写一条当前 `escalation_chain`，全部虚拟申请人的直属上级又都是当前登录 Owner，因此演示项目看不到真实的多人流转历史。本轮已补足多名虚拟处理人、已转交节点、处理意见和多个当前阶段。
2. 当前后端是**升级阶梯**，不是**强制顺序审批流**。当前人只要有终局权限就能直接批准；资源持有人、部门 POC、制作人、Owner 是向上转交时的候选阶梯，不是每条申请都必须依次经过的节点。
3. 抄送、审批后的处理/开通、自定义节点、多人会签、模板版本和条件分支尚未建模，不能靠前端把几个卡片画出来就宣称已支持。

因此，本轮 UI 将“当前真实实例”和“目标流程模板设计器”分开：实例时间线继续只展示审计数据；流程设置页允许在本机设计、增删、排序节点，但发布按钮保持禁用，等待后端契约落地。

## 市场模式依据

- Microsoft Power Automate 官方把多人审批明确拆为 `Everyone must approve`、`First to respond`、自定义响应和 `Sequential approval`。这意味着节点策略必须是模型字段，不能只靠人员数组推断。  
  https://learn.microsoft.com/en-us/power-automate/get-started-approvals
- Power Automate 的预设审批支持静态用户、动态处理人、通知和超时委托规则，证明“处理人来源”与“具体人员快照”需要拆开。  
  https://learn.microsoft.com/en-us/power-automate/guidance/business-approvals-templates/configure-preset-approvals
- Jira Service Management 将审批步骤绑定到工作流状态，审批通过与拒绝分别进入不同转换；处理人既可来自预设人员/群组，也可来自请求字段或服务关联人员。  
  https://support.atlassian.com/jira-service-management-cloud/docs/set-up-approvals/
- 钉钉官方材料支持按发起人属性配置条件分支，每个分支可独立设置审批人与抄送对象。  
  https://www.dingtalk.com/qidian/page-ugwQue8I.html

基于以上共同模式，前端草案的最小节点结构为：

```ts
type FlowNode = {
  id: string;
  type: "approval" | "cc" | "processing";
  title: string;
  assigneeSource:
    | "supervisor"
    | "project_role"
    | "resource_owner"
    | "project_owner"
    | "department_poc"
    | "specific_members";
  decisionMode: "any" | "all" | "sequential";
  timeoutHours: number | null;
  optional: boolean;
};
```

## 当前后端冲突与缺口

### P0：不解决就无法发布模板

1. **没有模板实体与版本**  
   当前只有 `production_approval_config.ttl_hours`。需要 `approval_flow_template`、`approval_flow_template_version`、节点表/JSON、草稿/已发布状态、适用资源范围和启停状态。

2. **运行实例没有模板快照**  
   `approval_request` 只有已经到达过的 `escalation_chain`。提交时必须保存 `templateVersionId` 与解析后的节点/处理人快照，否则管理员修改模板会让运行中实例改变含义。

3. **执行引擎语义冲突**  
   `approveAccessRequest` 当前任一 `canFinalize=true` 的处理人即可把申请直接置为 `approved`。模板化之后应完成“当前节点”，再按节点顺序/分支推进；只有结束节点才能进入审批通过终态。

4. **缺少节点类型**  
   目前只支持审批阶梯。需要 `approval`、`cc`、`processing`，并分别记录决定、通知/已读、处理完成/失败；“审批通过”和“资源已开通”不能继续共用同一个终态。

5. **缺少多人决定记录**  
   当前 `current_approver_ids` 的语义固定为任一人处理即可。`all` 和 `sequential` 需要每个处理人的独立 response、comment、actedAt，并处理一人拒绝后的节点终止策略。

### P1：会造成展示或审计不准确

6. **详情页拿不到后续人员**  
   现有 preview 接口只按当前 session 用户计算，适合申请人提交前预览；审批方查看他人申请时不能复用，否则会返回审批人的组织链。需要按 `requestId` 读取、且经过实例可见性校验的预览/实例接口。

7. **动态路由与展示口径不一致**  
   当前阶梯每次转交都会按最新组织关系重算。产品需要决定：页面展示“提交时快照”还是“当前预测”；建议实例主流程展示快照，另以提示展示人员变化后的当前预测。

8. **抄送没有可追溯状态**  
   需要 recipients、notifiedAt、readAt、deliveryStatus。抄送人无审批权，但应能在通知中心归档与追溯。

9. **处理节点缺少领域接口**  
   权限开通、物料发放、账号创建等处理动作不同。需要 `processing_task` 或领域 handler 契约、负责人、完成/失败原因、重试和幂等键。

10. **缺少模板编辑权限与审计**  
    需要明确谁能创建、编辑、发布、停用模板，以及每次版本变更的操作者、差异与时间。仅凭项目成员身份不能开放“流程设置”。

### P2：规模化前建议补齐

11. 条件分支：资源类型、权限等级、风险等级、发起人部门/角色、有效期等。
12. 空处理人策略：跳过、回退到 Owner、阻塞并告警，不能只有统一默认。
13. 超时策略：提醒、委托、自动升级、自动拒绝分别建模。
14. 并发编辑：版本号或 ETag，避免管理员相互覆盖。
15. 模板引用统计与删除约束：有运行实例的已发布版本只能停用，不能物理删除。

## 建议接口草案

```text
GET    /api/production/:id/approval-flow-templates
POST   /api/production/:id/approval-flow-templates
GET    /api/production/:id/approval-flow-templates/:templateId
PATCH  /api/production/:id/approval-flow-templates/:templateId
POST   /api/production/:id/approval-flow-templates/:templateId/publish
POST   /api/production/:id/approval-flow-templates/:templateId/preview

GET    /api/production/:id/access-requests/:requestId/flow
POST   /api/production/:id/access-requests/:requestId/nodes/:nodeId/respond
POST   /api/production/:id/access-requests/:requestId/nodes/:nodeId/complete
```

其中实例 `flow` 响应至少应返回：模板版本、全部节点、每个节点的类型/策略/状态、解析后的相关人、个人决定记录、抄送送达记录、处理结果和允许当前用户执行的动作。

