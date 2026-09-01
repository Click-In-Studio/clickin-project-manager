export type ApprovalTemplateNodeType = "approval" | "cc" | "processing";
export type ApprovalDecisionMode = "any" | "all" | "sequential";
export type ApprovalAssigneeSource =
  | "supervisor"
  | "project_role"
  | "resource_owner"
  | "project_owner"
  | "department_poc"
  | "specific_members";

export type ApprovalTemplateNode = {
  id: string;
  type: ApprovalTemplateNodeType;
  title: string;
  assigneeSource: ApprovalAssigneeSource;
  assigneeLabel: string;
  decisionMode: ApprovalDecisionMode;
  timeoutHours: number | null;
  optional: boolean;
};

export type ApprovalFlowTemplate = {
  id: string;
  name: string;
  description: string;
  resourceScope: string;
  enabled: boolean;
  nodes: ApprovalTemplateNode[];
};

export const APPROVAL_NODE_TYPE_LABELS: Record<ApprovalTemplateNodeType, string> = {
  approval: "审批",
  cc: "抄送",
  processing: "处理",
};

export const APPROVAL_DECISION_MODE_LABELS: Record<ApprovalDecisionMode, string> = {
  any: "任一人通过",
  all: "全员通过",
  sequential: "依次处理",
};

export const APPROVAL_ASSIGNEE_SOURCE_LABELS: Record<ApprovalAssigneeSource, string> = {
  supervisor: "发起人的直属上级",
  project_role: "项目角色",
  resource_owner: "资源负责人 / Owner",
  project_owner: "项目 Owner",
  department_poc: "部门 POC",
  specific_members: "指定成员",
};

export const DEFAULT_APPROVAL_FLOW_TEMPLATES: ApprovalFlowTemplate[] = [
  {
    id: "resource-standard",
    name: "标准资源权限",
    description: "适合 Cue、剧本段落、事件等日常协作资源。",
    resourceScope: "Cue 表、章节/段落、事件",
    enabled: true,
    nodes: [
      {
        id: "supervisor-review",
        type: "approval",
        title: "直属上级审批",
        assigneeSource: "supervisor",
        assigneeLabel: "发起人的直属上级",
        decisionMode: "sequential",
        timeoutHours: 24,
        optional: false,
      },
      {
        id: "pm-review",
        type: "approval",
        title: "PM 审批",
        assigneeSource: "project_role",
        assigneeLabel: "项目经理 / 制作经理",
        decisionMode: "any",
        timeoutHours: 24,
        optional: false,
      },
      {
        id: "management-cc",
        type: "cc",
        title: "抄送项目管理",
        assigneeSource: "project_role",
        assigneeLabel: "制作人、项目负责人",
        decisionMode: "any",
        timeoutHours: null,
        optional: true,
      },
      {
        id: "resource-provision",
        type: "processing",
        title: "资源开通与确认",
        assigneeSource: "resource_owner",
        assigneeLabel: "资源负责人 / Owner",
        decisionMode: "any",
        timeoutHours: 8,
        optional: false,
      },
    ],
  },
  {
    id: "resource-fast",
    name: "低风险快速授权",
    description: "查看类权限由直属上级确认后交给资源负责人处理。",
    resourceScope: "查看、临时访问",
    enabled: true,
    nodes: [
      {
        id: "fast-supervisor",
        type: "approval",
        title: "直属上级确认",
        assigneeSource: "supervisor",
        assigneeLabel: "发起人的直属上级",
        decisionMode: "any",
        timeoutHours: 12,
        optional: false,
      },
      {
        id: "fast-provision",
        type: "processing",
        title: "资源授权",
        assigneeSource: "resource_owner",
        assigneeLabel: "资源负责人 / Owner",
        decisionMode: "any",
        timeoutHours: 8,
        optional: false,
      },
    ],
  },
  {
    id: "resource-sensitive",
    name: "高风险发布权限",
    description: "发布、管理等高风险权限需多人共同确认并保留知会链。",
    resourceScope: "发布、管理、敏感资源",
    enabled: true,
    nodes: [
      {
        id: "sensitive-supervisor",
        type: "approval",
        title: "直属上级审批",
        assigneeSource: "supervisor",
        assigneeLabel: "发起人的直属上级",
        decisionMode: "sequential",
        timeoutHours: 12,
        optional: false,
      },
      {
        id: "sensitive-owners",
        type: "approval",
        title: "项目管理会签",
        assigneeSource: "project_role",
        assigneeLabel: "PM、制作人",
        decisionMode: "all",
        timeoutHours: 24,
        optional: false,
      },
      {
        id: "sensitive-owner",
        type: "approval",
        title: "项目 Owner 终审",
        assigneeSource: "project_owner",
        assigneeLabel: "项目 Owner",
        decisionMode: "any",
        timeoutHours: 24,
        optional: false,
      },
      {
        id: "sensitive-cc",
        type: "cc",
        title: "抄送安全与制作团队",
        assigneeSource: "project_role",
        assigneeLabel: "安全负责人、制作团队",
        decisionMode: "any",
        timeoutHours: null,
        optional: true,
      },
      {
        id: "sensitive-provision",
        type: "processing",
        title: "执行开通",
        assigneeSource: "resource_owner",
        assigneeLabel: "资源负责人 / Owner",
        decisionMode: "any",
        timeoutHours: 4,
        optional: false,
      },
    ],
  },
];

export function createApprovalTemplateNode(
  type: ApprovalTemplateNodeType,
  ordinal: number,
): ApprovalTemplateNode {
  const defaults: Record<ApprovalTemplateNodeType, Omit<ApprovalTemplateNode, "id">> = {
    approval: {
      type,
      title: "新增审批节点",
      assigneeSource: "project_role",
      assigneeLabel: "请选择审批角色",
      decisionMode: "any",
      timeoutHours: 24,
      optional: false,
    },
    cc: {
      type,
      title: "新增抄送节点",
      assigneeSource: "project_role",
      assigneeLabel: "请选择抄送对象",
      decisionMode: "any",
      timeoutHours: null,
      optional: true,
    },
    processing: {
      type,
      title: "新增处理节点",
      assigneeSource: "resource_owner",
      assigneeLabel: "资源负责人 / Owner",
      decisionMode: "any",
      timeoutHours: 8,
      optional: false,
    },
  };

  return { id: `${type}-${ordinal}`, ...defaults[type] };
}

export function moveApprovalTemplateNode(
  nodes: ApprovalTemplateNode[],
  fromIndex: number,
  direction: -1 | 1,
): ApprovalTemplateNode[] {
  const toIndex = fromIndex + direction;
  if (fromIndex < 0 || fromIndex >= nodes.length || toIndex < 0 || toIndex >= nodes.length) {
    return nodes;
  }
  const next = [...nodes];
  [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
  return next;
}
