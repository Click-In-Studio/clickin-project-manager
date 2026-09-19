import type { ProductionEvent } from "@/lib/ops/event-db";

export type PlanningMilestone = { id: string; name: string; endDate: string };
export type PlanningDept = { id: string; name: string };
export type PlanningMember = { userId: string; name: string; roles: string[]; departmentIds: string[] };

export type PlanningPhase = {
  id: string;
  name: string;
  /** null = production-level */
  deptId: string | null;
  deptName: string | null;
  startDate: string;
  /** null = 尾巴未定（日历持续覆盖；甘特画到轴右缘渐隐） */
  endDate: string | null;
  milestoneIds: string[];
};

export type PhasePerm = {
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  pocDeptIds: string[];
  deptPocEnabled: boolean;
};

/** 三视图共用的任务形状（server page 按 task/*@view 全量或"与我相关"降级投喂）。 */
export type PlanningTask = {
  id: string;
  title: string;
  status: string;
  departmentId: string | null;
  departmentName: string | null;
  eventId: string | null;
  eventTitle: string | null;
  /** 自身起止（甘特拖拽写回目标） */
  startTime: string | null;
  endTime: string | null;
  /** 有效起止：自身 → 绑定 schedule min/max → event */
  effectiveStartTime: string | null;
  effectiveEndTime: string | null;
  isBlocked: boolean;
  description: string;
};

export type Props = {
  productionId: string;
  events: ProductionEvent[];
  tasks: PlanningTask[];
  milestones: PlanningMilestone[];
  phases: PlanningPhase[];
  departments: PlanningDept[];
  members: PlanningMember[];
  /** 阶段归属候选（仅 kind='dept'——用户组不该有阶段） */
  deptOptions: PlanningDept[];
  phasePerm: PhasePerm;
  editableEventIds: string[];
  editableTaskIds: string[];
};
