/**
 * 审批流程模版：词表与校验 —— **前后端共用的唯一来源**（prA，设计见
 * docs/approval-flow-template-design-2026-09-03.md §8）。
 *
 * 词表收敛纪律：处理人来源建立在 `ApprovalStageName` 之上，只新增真正的新值
 * （project_role / specific_members）。不允许出现 resource_owner≈holder、
 * department_poc≈dept_poc 这类平行词表——lib/approval-stages.ts 开篇记载的
 * 展示漂移就是双词表的下场。ancestor_poc 不在此列：逐层向上是节点**内部**的
 * 升级行为（设计文档 §2），不是可指派的节点来源。
 *
 * 此模块**不得** import 任何带 pg / node 依赖的东西：设计器是 "use client" 组件。
 */
import {
  APPROVAL_STAGE_LABELS,
  type ApprovalStageName,
} from "./approval-stages";

export type ApprovalTemplateNodeType = "approval" | "cc" | "processing";

/**
 * 多人策略。类型上保留全集（快照结构为会签预留 responses[]），但 v1 存储与
 * 引擎只支持或签——白名单见 SUPPORTED_DECISION_MODES。服务端按白名单拒绝，
 * 不按类型全集：**存进去的模版必须是引擎能跑的模版**，否则发布就是空头支票。
 */
export type ApprovalDecisionMode = "any" | "all" | "sequential";
export const SUPPORTED_DECISION_MODES: readonly ApprovalDecisionMode[] = ["any"];

/** 节点处理人来源：阶梯级名子集 + 两个真正的新值。 */
export type ApprovalAssigneeSource =
  | Exclude<ApprovalStageName, "ancestor_poc">
  | "project_role"
  | "specific_members";

export const APPROVAL_ASSIGNEE_SOURCE_LABELS: Record<ApprovalAssigneeSource, string> = {
  // 阶梯级沿用同一份展示名，改 approval-stages 两边一起变。
  supervisor: APPROVAL_STAGE_LABELS.supervisor,
  holder: APPROVAL_STAGE_LABELS.holder,
  dept_poc: APPROVAL_STAGE_LABELS.dept_poc,
  producer: APPROVAL_STAGE_LABELS.producer,
  owner: APPROVAL_STAGE_LABELS.owner,
  project_role: "项目角色",
  specific_members: "指定成员",
};

export const APPROVAL_NODE_TYPE_LABELS: Record<ApprovalTemplateNodeType, string> = {
  approval: "审批",
  cc: "抄送",
  processing: "处理",
};

/** 与 production_approval_config.ttl_hours 的 DB CHECK 同源（1..720）。 */
export const NODE_TIMEOUT_MIN_HOURS = 1;
export const NODE_TIMEOUT_MAX_HOURS = 720;
export const MAX_TEMPLATE_NODES = 20;
export const MAX_TEMPLATE_NAME_LENGTH = 60;
export const MAX_NODE_TITLE_LENGTH = 60;

export type ApprovalTemplateNode = {
  /** 模版内唯一；prC 设计器用 crypto.randomUUID() 生成。 */
  id: string;
  type: ApprovalTemplateNodeType;
  title: string;
  assigneeSource: ApprovalAssigneeSource;
  /** assigneeSource === "project_role" 时必填非空。 */
  roleNames?: string[];
  /** assigneeSource === "specific_members" 时必填非空（app_user.id）。 */
  memberIds?: string[];
  /** 仅 approval 节点有意义（cc/processing 不带，#405 review 的判别并集教训）；v1 只收 "any"。 */
  decisionMode?: ApprovalDecisionMode;
  /** cc 节点恒 null（到达即投递不等待）；其余节点 null = 不超时。 */
  timeoutHours: number | null;
  /** 空处理人策略 v1 二值：true = 跳过，false = 兜底 owner（设计文档 §6）。 */
  optional: boolean;
};

export type ApprovalFlowTemplateStatus = "draft" | "published";

const NODE_TYPES = new Set<string>(["approval", "cc", "processing"]);
const ASSIGNEE_SOURCES = new Set<string>(Object.keys(APPROVAL_ASSIGNEE_SOURCE_LABELS));

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

/**
 * 节点数组的运行时白名单校验。返回错误列表（空数组 = 合法）。
 * 服务端在 create / update 时调用——**不信任客户端枚举**；prC 设计器可复用
 * 同一份做提交前提示，两边不会漂。
 */
export function validateTemplateNodes(nodes: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(nodes)) return ["nodes 必须是数组"];
  if (nodes.length === 0) return ["模版至少需要一个节点"];
  if (nodes.length > MAX_TEMPLATE_NODES) return [`节点数不能超过 ${MAX_TEMPLATE_NODES}`];

  const seenIds = new Set<string>();
  let actionable = 0;
  nodes.forEach((raw, i) => {
    const at = `节点[${i}]`;
    if (typeof raw !== "object" || raw === null) { errors.push(`${at} 不是对象`); return; }
    const node = raw as Record<string, unknown>;

    if (typeof node.id !== "string" || node.id.length === 0 || node.id.length > 80) {
      errors.push(`${at} id 缺失或非法`);
    } else if (seenIds.has(node.id)) {
      errors.push(`${at} id 与前面的节点重复：${node.id}`);
    } else {
      seenIds.add(node.id);
    }

    if (typeof node.type !== "string" || !NODE_TYPES.has(node.type)) {
      errors.push(`${at} type 非法：${String(node.type)}`);
      return; // 后续规则都依赖 type，别在坏 type 上叠报错噪音
    }
    const type = node.type as ApprovalTemplateNodeType;
    if (type !== "cc") actionable += 1;

    if (typeof node.title !== "string" || node.title.trim().length === 0
        || node.title.length > MAX_NODE_TITLE_LENGTH) {
      errors.push(`${at} title 缺失或超长（≤${MAX_NODE_TITLE_LENGTH}）`);
    }

    if (typeof node.assigneeSource !== "string" || !ASSIGNEE_SOURCES.has(node.assigneeSource)) {
      errors.push(`${at} assigneeSource 非法：${String(node.assigneeSource)}`);
    } else {
      if (node.assigneeSource === "project_role" && !isStringArray(node.roleNames)) {
        errors.push(`${at} 来源为项目角色时 roleNames 必填非空`);
      }
      if (node.assigneeSource === "specific_members" && !isStringArray(node.memberIds)) {
        errors.push(`${at} 来源为指定成员时 memberIds 必填非空`);
      }
    }

    if (type === "approval") {
      if (!SUPPORTED_DECISION_MODES.includes(node.decisionMode as ApprovalDecisionMode)) {
        errors.push(`${at} decisionMode 暂不支持：${String(node.decisionMode)}（v1 仅 any）`);
      }
    } else if (node.decisionMode !== null && node.decisionMode !== undefined) {
      // 类型切换残留的 decisionMode 不许落库（#405 review：cc 节点带着幽灵 "all"
      // 序列化进草稿，读的人分不清它是否承载语义）。
      errors.push(`${at} ${type} 节点不接受 decisionMode`);
    }

    if (type === "cc") {
      if (node.timeoutHours !== null && node.timeoutHours !== undefined) {
        errors.push(`${at} 抄送节点不等待，timeoutHours 必须为 null`);
      }
    } else if (node.timeoutHours !== null && node.timeoutHours !== undefined) {
      if (typeof node.timeoutHours !== "number" || !Number.isInteger(node.timeoutHours)
          || node.timeoutHours < NODE_TIMEOUT_MIN_HOURS || node.timeoutHours > NODE_TIMEOUT_MAX_HOURS) {
        errors.push(`${at} timeoutHours 必须是 ${NODE_TIMEOUT_MIN_HOURS}..${NODE_TIMEOUT_MAX_HOURS} 的整数或 null`);
      }
    }

    if (typeof node.optional !== "boolean") {
      errors.push(`${at} optional 必须是布尔`);
    }
  });

  // 纯抄送模版会在提交瞬间自动走完（cc 到达即投递不等待）——那不是审批流，
  // 是伪装成审批流的群发通知，禁掉。
  if (actionable === 0) errors.push("模版至少需要一个审批或处理节点");

  return errors;
}
