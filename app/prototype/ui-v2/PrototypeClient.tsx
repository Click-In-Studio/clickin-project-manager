"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./prototype.module.css";

type View =
  | "home"
  | "project"
  | "script"
  | "dramaturgy"
  | "table"
  | "assets"
  | "cue"
  | "people"
  | "milestones"
  | "events"
  | "tasks"
  | "notifications"
  | "planning"
  | "finance"
  | "materials"
  | "framework";

type Role = "制作人 / 舞监" | "导演 / 构作" | "设计 / 技术" | "演员";
type PlanningView = "calendar" | "gantt" | "timetable";
type PlannerObjectType = "event" | "task" | "milestone";
type PlannerItem = {
  id: string;
  type: PlannerObjectType;
  title: string;
  date: string;
  time?: string;
  meta: string;
  relation?: string;
};

type MilestoneStatus = "未开始" | "筹备中" | "进行中" | "有风险" | "已完成";
type GanttScale = "day" | "month" | "quarter" | "year";
type MilestoneDragMode = "move" | "resize-start" | "resize-end";
type MilestoneRecord = {
  id: string;
  phase: string;
  title: string;
  childTasks: string[];
  completedTasks: string[];
  status: MilestoneStatus;
  start: string;
  end: string;
  owner: string;
  department: string;
  docs: string;
  details: string;
};

const INITIAL_MILESTONES: MilestoneRecord[] = [
  { id: "m-creative", phase: "1期 · 启动筹备期", title: "创作整理与重编", childTasks: ["剧本文本整理", "音乐版本确认"], completedTasks: ["剧本文本整理", "音乐版本确认"], status: "已完成", start: "2026-07-08", end: "2026-07-18", owner: "陈嘉", department: "导演组", docs: "剧本 V12", details: "锁定演出文本、音乐总谱与创作口径。" },
  { id: "m-team", phase: "1期 · 启动筹备期", title: "核心团队组建", childTasks: ["主创确认", "部门负责人到位"], completedTasks: ["主创确认", "部门负责人到位"], status: "已完成", start: "2026-07-10", end: "2026-07-22", owner: "林淼", department: "制作组", docs: "通讯录", details: "完成主创、制作及技术团队组织。" },
  { id: "m-cast", phase: "1期 · 启动筹备期", title: "人员招募与建组", childTasks: ["海选方案", "演员定组"], completedTasks: ["海选方案"], status: "进行中", start: "2026-07-15", end: "2026-07-29", owner: "王玥", department: "演员组", docs: "选角表", details: "完成演员筛选、合同及首次建组。" },
  { id: "m-training", phase: "2期 · 排演期", title: "卡司集训", childTasks: ["声乐集训", "形体排练"], completedTasks: ["声乐集训"], status: "进行中", start: "2026-07-23", end: "2026-08-05", owner: "周嘉", department: "导演组", docs: "训练计划", details: "按角色组完成声乐、形体与文本集训。" },
  { id: "m-stage", phase: "2期 · 排演期", title: "舞美工作前期准备", childTasks: ["舞台方案", "道具清单"], completedTasks: [], status: "有风险", start: "2026-07-27", end: "2026-08-10", owner: "徐宁", department: "舞美制作", docs: "舞美方案", details: "舞台结构、置景与关键道具进入交付。" },
  { id: "m-tech", phase: "3期 · 合成期", title: "合成排练", childTasks: ["技术联排", "部门 Notes"], completedTasks: [], status: "筹备中", start: "2026-08-06", end: "2026-08-13", owner: "林淼", department: "舞监组", docs: "Rundown", details: "灯光、音响、多媒体与舞台完成合成。" },
];

const getMilestoneProgress = (record: MilestoneRecord) => record.childTasks.length === 0
  ? 0
  : Math.round(record.completedTasks.filter((task) => record.childTasks.includes(task)).length / record.childTasks.length * 100);

const INITIAL_PLANNER_ITEMS: PlannerItem[] = [
  { id: "task-size", type: "task", title: "确认舞台尺寸与承重点", date: "2026-07-14", meta: "舞美组 · 截止日", relation: "独立 Task · 舞台可交付" },
  { id: "event-scene3", type: "event", title: "第三幕合成排练", date: "2026-07-20", time: "13:30–18:00", meta: "黑匣子 B · 18 人", relation: "首演准备" },
  { id: "task-cue", type: "task", title: "Cue 联调", date: "2026-07-20", time: "16:45", meta: "灯光 / 音响 / 多媒体", relation: "第三幕合成排练" },
  { id: "milestone-stage", type: "milestone", title: "舞台可交付", date: "2026-07-25", meta: "首演里程碑", relation: "7 / 10 Task 已完成" },
  { id: "event-run", type: "event", title: "第一次全本联排", date: "2026-07-27", time: "14:00–20:00", meta: "城市剧院 · 全体", relation: "首演准备" },
];
type AccountPage = "profile" | "security" | "preferences" | "privacy" | "help" | "adminPeople" | "adminBudget";
type BudgetStatus = "待填报" | "待复核" | "已批准" | "已下单" | "已支付" | "超预算";
type BudgetRecord = {
  id: string;
  item: string;
  code: string;
  department: string;
  phase: string;
  task: string;
  category: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  budget: number;
  actual: number;
  channel: string;
  owner: string;
  status: BudgetStatus;
};
type ProjectOption = { id: string; organization: string; name: string; avatar: string };
type PlanningEvent = {
  id: string; title: string; date: string; start: string; end: string;
  location: string; status: "筹备中" | "已发布"; milestone: string;
};
type PlanningPerson = { id: string; name: string; department: string };
type RundownLane = { id: string; label: string; owner: string; tone: "main" | "script" | "stage" };
type RundownItem = {
  id: string; eventId: string; title: string; start: string; end: string; location: string;
  laneIds: string[]; participantIds: string[]; type: "call" | "run" | "task" | "break" | "notes";
  taskIds: string[]; note: string;
};
type LinkedPlanTask = {
  id: string; eventId: string; scheduleItemId: string; title: string;
  ownerIds: string[]; due: string; status: "待开始" | "进行中" | "已完成" | "有风险";
};

const ACCOUNT_MENU_ITEMS: { id: AccountPage; label: string }[] = [
  { id: "profile", label: "个人信息" },
  { id: "security", label: "账号安全中心" },
  { id: "preferences", label: "功能与设置" },
  { id: "privacy", label: "信息隐私与权限" },
  { id: "help", label: "帮助与反馈" },
];

const BUDGET_RECORDS: BudgetRecord[] = [
  { id: "LUXUN013", item: "音乐｜PV 打印", code: "LUXUN013", department: "舞美制作", phase: "筹备期", task: "创作整理", category: "资料打印", quantity: 50, unit: "份", unitPrice: 8, budget: 400, actual: 400, channel: "线下供应商", owner: "徐宁", status: "已支付" },
  { id: "LUXUN014", item: "音乐｜剧本打印", code: "LUXUN014", department: "舞美制作", phase: "筹备期", task: "创作整理", category: "资料打印", quantity: 60, unit: "份", unitPrice: 6, budget: 360, actual: 360, channel: "线下供应商", owner: "徐宁", status: "已支付" },
  { id: "LUXUN015", item: "音乐｜乐手谱打印", code: "LUXUN015", department: "音响", phase: "筹备期", task: "音乐制作", category: "资料打印", quantity: 30, unit: "份", unitPrice: 10, budget: 300, actual: 0, channel: "待选择", owner: "周嘉", status: "待复核" },
  { id: "LUXUN016", item: "音乐｜制谱工作", code: "LUXUN016", department: "音响", phase: "制作期", task: "音乐制作", category: "人工运费", quantity: 1, unit: "项", unitPrice: 1600, budget: 1600, actual: 1680, channel: "个人服务", owner: "周嘉", status: "超预算" },
  { id: "LUXUN099", item: "书籍｜《鲁迅传》许寿裳", code: "LUXUN099", department: "导演组", phase: "筹备期", task: "创作整理", category: "书本资料", quantity: 2, unit: "本", unitPrice: 30, budget: 60, actual: 0, channel: "电商采购", owner: "陈嘉", status: "已批准" },
  { id: "LUXUN100", item: "书籍｜《鲁迅传》朱正", code: "LUXUN100", department: "导演组", phase: "筹备期", task: "创作整理", category: "书本资料", quantity: 3, unit: "本", unitPrice: 40, budget: 120, actual: 0, channel: "电商采购", owner: "陈嘉", status: "已下单" },
  { id: "STAGE021", item: "舞台右侧护栏加固材料", code: "STAGE021", department: "舞美制作", phase: "联排期", task: "舞台安全整改", category: "舞台材料", quantity: 1, unit: "批", unitPrice: 32600, budget: 32600, actual: 0, channel: "询价采购", owner: "徐宁", status: "待复核" },
  { id: "MEDIA018", item: "海浪视频素材追加授权", code: "MEDIA018", department: "多媒体", phase: "联排期", task: "第三幕技术闭环", category: "版权授权", quantity: 1, unit: "项", unitPrice: 18000, budget: 18000, actual: 0, channel: "版权方直采", owner: "韩松", status: "待复核" },
];

const VIEW_META: Record<View, { label: string; eyebrow: string; side?: "script" | "stage" }> = {
  home: { label: "我的工作", eyebrow: "平台级" },
  project: { label: "项目首页", eyebrow: "《海边的罗密欧》" },
  script: { label: "剧本", eyebrow: "创作侧", side: "script" },
  dramaturgy: { label: "构作", eyebrow: "创作侧", side: "script" },
  table: { label: "表格", eyebrow: "创作侧", side: "script" },
  assets: { label: "数字资产", eyebrow: "创作侧", side: "script" },
  cue: { label: "Cue", eyebrow: "创作侧", side: "script" },
  people: { label: "人员与角色", eyebrow: "制作侧", side: "stage" },
  milestones: { label: "里程碑", eyebrow: "制作侧", side: "stage" },
  events: { label: "节点与事件", eyebrow: "制作侧", side: "stage" },
  tasks: { label: "任务", eyebrow: "制作侧", side: "stage" },
  notifications: { label: "通知", eyebrow: "制作侧", side: "stage" },
  planning: { label: "计划与日程", eyebrow: "制作侧", side: "stage" },
  finance: { label: "财务", eyebrow: "制作侧", side: "stage" },
  materials: { label: "资产盘点", eyebrow: "制作侧", side: "stage" },
  framework: { label: "产品框架说明", eyebrow: "交付给产品 / 设计 / 开发" },
};

const SCRIPT_NAV: { id: View; label: string; hint: string }[] = [
  { id: "script", label: "剧本", hint: "文本创作 · 版本 · 协作" },
  { id: "dramaturgy", label: "构作", hint: "叙事结构 · 节奏 · 舞台转化" },
  { id: "table", label: "表格", hint: "场次拆分 · 角色 · 时长" },
  { id: "assets", label: "数字资产", hint: "设计文件 · 图纸 · 音视频" },
  { id: "cue", label: "Cue", hint: "技术指令 · 部门联动" },
];

const PROJECTS: ProjectOption[] = [
  { id: "romeo", organization: "棱镜剧团", name: "海边的罗密欧", avatar: "海" },
  { id: "teahouse", organization: "棱镜剧团", name: "茶馆", avatar: "茶" },
  { id: "school", organization: "青年剧社", name: "春季汇演", avatar: "春" },
];

const PLANNING_PEOPLE: PlanningPerson[] = [
  { id: "lin", name: "林淼", department: "舞监 / 场务" },
  { id: "chen", name: "陈洛华", department: "演员" },
  { id: "wang", name: "王恺镔", department: "灯光" },
  { id: "zhou", name: "周嘉", department: "音响" },
  { id: "han", name: "韩松", department: "多媒体" },
  { id: "xu", name: "徐宁", department: "置景 / 道具" },
];

const PLANNING_EVENTS: PlanningEvent[] = [
  { id: "e-tech", title: "第三幕合成排练", date: "7 月 20 日", start: "13:00", end: "16:00", location: "黑匣子 B", status: "已发布", milestone: "第三幕技术闭环" },
  { id: "e-run", title: "第一次全本联排", date: "7 月 27 日", start: "12:30", end: "18:30", location: "排练厅 A", status: "筹备中", milestone: "全本首次连续运行" },
  { id: "e-premiere", title: "首演", date: "8 月 13 日", start: "17:00", end: "22:00", location: "城市剧院", status: "筹备中", milestone: "首演交付" },
];

const RUNDOWN_LANES: RundownLane[] = [
  { id: "stage", label: "舞监 / 场务", owner: "林淼 · 徐宁", tone: "stage" },
  { id: "cast", label: "演员工作", owner: "陈洛华", tone: "stage" },
  { id: "light", label: "灯光", owner: "王恺镔", tone: "script" },
  { id: "audio", label: "音响", owner: "周嘉", tone: "script" },
  { id: "media", label: "多媒体", owner: "韩松", tone: "script" },
];

const RUNDOWN_ITEMS: RundownItem[] = [
  { id: "r-call", eventId: "e-tech", title: "全体 Call · 签到与设备预热", start: "13:00", end: "13:30", location: "黑匣子 B", laneIds: ["all"], participantIds: ["lin", "chen", "wang", "zhou", "han", "xu"], type: "call", taskIds: ["t-checkin"], note: "工作人员提前 30 分钟抵达；演员完成换装。" },
  { id: "r-stage", eventId: "e-tech", title: "第三幕走位与转场", start: "13:30", end: "14:30", location: "主舞台", laneIds: ["stage", "cast"], participantIds: ["lin", "chen", "xu"], type: "run", taskIds: ["t-route", "t-props"], note: "从海边平台到终场站位，确认右侧通道。" },
  { id: "r-light", eventId: "e-tech", title: "LX 34–42 编程与联调", start: "13:30", end: "14:30", location: "灯光控制台", laneIds: ["light"], participantIds: ["wang", "lin"], type: "task", taskIds: ["t-light"], note: "LX 38 淡出调整为 5 秒。" },
  { id: "r-audio", eventId: "e-tech", title: "SD 18–23 音量平衡", start: "13:30", end: "14:15", location: "音响控制台", laneIds: ["audio"], participantIds: ["zhou", "lin"], type: "task", taskIds: ["t-audio"], note: "确认海浪声与对白清晰度。" },
  { id: "r-media", eventId: "e-tech", title: "V 09–12 海浪素材同步", start: "13:45", end: "14:30", location: "多媒体席", laneIds: ["media"], participantIds: ["han", "lin"], type: "task", taskIds: ["t-media"], note: "视频淡出需与 LX 38 同步。" },
  { id: "r-break", eventId: "e-tech", title: "休息 / 各部门快速复盘", start: "14:30", end: "14:45", location: "休息区", laneIds: ["all"], participantIds: [], type: "break", taskIds: [], note: "有风险项在复跑前上报舞监。" },
  { id: "r-run", eventId: "e-tech", title: "第三幕连续运行", start: "14:45", end: "15:30", location: "主舞台", laneIds: ["all"], participantIds: ["lin", "chen", "wang", "zhou", "han", "xu"], type: "run", taskIds: ["t-run"], note: "不中断运行；部门问题先记录，结束后统一处理。" },
  { id: "r-notes", eventId: "e-tech", title: "部门 Notes · 查缺补漏", start: "15:30", end: "16:00", location: "观众席前排", laneIds: ["all"], participantIds: ["lin", "wang", "zhou", "han", "xu"], type: "notes", taskIds: ["t-notes"], note: "未完成事项自动形成部门 Task 草稿。" },
  { id: "r2-call", eventId: "e-run", title: "全体 Call 与热身", start: "12:30", end: "13:00", location: "排练厅 A", laneIds: ["all"], participantIds: ["lin", "chen"], type: "call", taskIds: [], note: "服化、道具和技术同步签到。" },
  { id: "r2-run", eventId: "e-run", title: "第一次全本连续运行", start: "13:00", end: "16:00", location: "排练厅 A", laneIds: ["all"], participantIds: ["lin", "chen", "wang", "zhou", "han", "xu"], type: "run", taskIds: ["t-fullrun"], note: "首次验证全本时长与转场节奏。" },
  { id: "r3-call", eventId: "e-premiere", title: "首演全体 Call · 安检与预热", start: "17:00", end: "18:00", location: "城市剧院", laneIds: ["all"], participantIds: ["lin", "chen", "wang", "zhou", "han", "xu"], type: "call", taskIds: [], note: "演员、技术与前台按首演 Call Sheet 到场。" },
  { id: "r3-show", eventId: "e-premiere", title: "首演 · 正式演出", start: "19:30", end: "21:45", location: "主舞台", laneIds: ["all"], participantIds: ["lin", "chen", "wang", "zhou", "han", "xu"], type: "run", taskIds: ["t-premiere"], note: "舞监按正式演出流程统一发出 Standby 与 Go。" },
  { id: "r3-notes", eventId: "e-premiere", title: "谢幕、撤场与演后 Notes", start: "21:45", end: "22:00", location: "主舞台 / 后台", laneIds: ["all"], participantIds: ["lin", "wang", "zhou", "han", "xu"], type: "notes", taskIds: [], note: "记录设备、道具与次日复演事项。" },
];

const LINKED_PLAN_TASKS: LinkedPlanTask[] = [
  { id: "t-checkin", eventId: "e-tech", scheduleItemId: "r-call", title: "确认全员签到与 Call", ownerIds: ["lin"], due: "13:10", status: "进行中" },
  { id: "t-route", eventId: "e-tech", scheduleItemId: "r-stage", title: "确认第三幕转场动线", ownerIds: ["lin", "xu"], due: "14:20", status: "进行中" },
  { id: "t-light", eventId: "e-tech", scheduleItemId: "r-light", title: "完成 LX 38 淡出修订", ownerIds: ["wang"], due: "14:20", status: "有风险" },
  { id: "t-audio", eventId: "e-tech", scheduleItemId: "r-audio", title: "确认海浪声压与对白", ownerIds: ["zhou"], due: "14:10", status: "已完成" },
  { id: "t-media", eventId: "e-tech", scheduleItemId: "r-media", title: "锁定海浪视频最终版", ownerIds: ["han"], due: "14:20", status: "待开始" },
  { id: "t-props", eventId: "e-tech", scheduleItemId: "r-props", title: "检查平台和关键道具", ownerIds: ["xu"], due: "13:50", status: "已完成" },
  { id: "t-run", eventId: "e-tech", scheduleItemId: "r-run", title: "记录连续运行问题", ownerIds: ["lin"], due: "15:35", status: "待开始" },
  { id: "t-notes", eventId: "e-tech", scheduleItemId: "r-notes", title: "分派部门 Notes", ownerIds: ["lin"], due: "16:00", status: "待开始" },
  { id: "t-fullrun", eventId: "e-run", scheduleItemId: "r2-run", title: "确认全本联排执行清单", ownerIds: ["lin"], due: "7 月 26 日", status: "进行中" },
  { id: "t-premiere", eventId: "e-premiere", scheduleItemId: "r3-show", title: "执行首演正式 Rundown", ownerIds: ["lin"], due: "21:45", status: "待开始" },
];

const NAV_GLYPHS: Record<View, string> = {
  home: "今",
  project: "项",
  script: "文",
  dramaturgy: "构",
  table: "表",
  assets: "库",
  cue: "Cue",
  people: "人",
  milestones: "◆",
  events: "节",
  tasks: "任",
  notifications: "通",
  planning: "计",
  finance: "¥",
  materials: "物",
  framework: "i",
};

const STAGE_NAV: { id: View; label: string; hint: string }[] = [
  { id: "milestones", label: "里程碑", hint: "项目阶段 · 关键交付 · 风险" },
  { id: "events", label: "节点与事件", hint: "围读 · 排练 · 演出" },
  { id: "tasks", label: "任务", hint: "执行事项 · 负责人 · 截止" },
  { id: "notifications", label: "通知", hint: "变更告知 · 确认 · 闭环" },
  { id: "planning", label: "计划与日程", hint: "日历 · 甘特 · 执行表" },
  { id: "finance", label: "财务", hint: "预算 · 采购 · 报销" },
  { id: "materials", label: "资产盘点", hint: "道具 · 服装 · 设备台账" },
];

const roleHome: Record<Role, { focus: string; secondary: string; note: string }> = {
  "制作人 / 舞监": {
    focus: "项目风险与未确认事项",
    secondary: "事件、任务、里程碑",
    note: "默认把跨部门风险、延期节点与未确认人员放在首页前部。",
  },
  "导演 / 构作": {
    focus: "剧本与排练内容",
    secondary: "构作、场次、评论",
    note: "默认突出最近剧本改动、章节时长和下一场排练的内容范围。",
  },
  "设计 / 技术": {
    focus: "部门 Cue 与交付",
    secondary: "任务、资产、物料",
    note: "默认突出本部门待执行 Cue、技术需求与文件更新。",
  },
  演员: {
    focus: "今天与我有关的事项",
    secondary: "Call、本人场次、确认",
    note: "默认隐藏管理噪声，首先显示到场时间、地点和必须确认的变化。",
  },
};

type AiSkillId = "weekly-task-review" | "feishu-group-summary" | "rundown-autoplan";
type AiPromptTemplate = { id: AiSkillId; label: string; prompt: string; description: string };
type AiAssistantRequest = { message: string; skill: AiSkillId | "auto"; context: { projectId: string; view: View } };
type AiAssistantResponse = { message: string; suggestedView?: View };

const AI_PROMPT_TEMPLATES: AiPromptTemplate[] = [
  { id: "weekly-task-review", label: "本周任务梳理", prompt: "帮我梳理本周所有任务，按负责人、截止时间和风险排序。", description: "汇总任务、阻塞与逾期风险" },
  { id: "feishu-group-summary", label: "飞书群聊摘要", prompt: "导入最近的飞书群聊，提取决定、待办和负责人并生成项目总结。", description: "提取决定、行动项和负责人" },
  { id: "rundown-autoplan", label: "执行日程自动排布", prompt: "根据当前事件的任务、人员和到场时间，生成一版可调整的执行日程。", description: "按依赖、人员和场地生成初稿" },
];

// AI 接入边界：开发阶段将此本地模拟实现替换为后端流式接口即可。
async function requestAiAssistant(payload: AiAssistantRequest): Promise<AiAssistantResponse> {
  await new Promise((resolve) => window.setTimeout(resolve, 420));
  const template = AI_PROMPT_TEMPLATES.find((item) => item.id === payload.skill);
  return {
    message: template
      ? `已调用「${template.label}」能力。接入真实 AI 后，将读取当前项目权限范围内的数据并返回可执行结果。`
      : "已收到。接入真实 AI 后，这里会结合当前项目、角色和页面上下文生成回答。",
    suggestedView: payload.skill === "rundown-autoplan" ? "planning" : payload.skill === "weekly-task-review" ? "tasks" : undefined,
  };
}

const moduleCopy: Partial<Record<View, { description: string; bullets: string[]; links: { label: string; target: View }[] }>> = {
  script: {
    description: "供导演、编剧与演员围绕文本本身阅读、编辑、评论和讨论。",
    bullets: ["版本切换与改动提示", "行级评论与角色讨论", "从台词直接查看关联 Cue"],
    links: [{ label: "查看关联角色", target: "people" }, { label: "打开 Cue", target: "cue" }],
  },
  dramaturgy: {
    description: "记录章节划分、时长设计、行动线、整体设计和舞台呈现思考。",
    bullets: ["章节与段落设计", "行动线和结构分析", "设计思路与素材挂接"],
    links: [{ label: "查看场次表格", target: "table" }, { label: "打开数字资产", target: "assets" }],
  },
  table: {
    description: "将剧本内容转为可筛选、可统计的场次和角色结构。",
    bullets: ["场次、角色、地点和时长", "按部门或标签筛选", "同一数据切换不同视图"],
    links: [{ label: "打开角色", target: "people" }, { label: "进入排练 Event", target: "events" }],
  },
  assets: {
    description: "统一管理工程文件、图纸、音视频和版本，不与实体物料混用。",
    bullets: ["文件版本与预览", "挂接剧本、Cue、Event 或 Task", "按部门和类型筛选"],
    links: [{ label: "查看关联 Cue", target: "cue" }, { label: "查看关联 Task", target: "tasks" }],
  },
  cue: {
    description: "记录灯光、音响、多媒体等部门针对具体台词或动作的执行设计。",
    bullets: ["锚定台词或舞台动作", "部门 Cue List", "在演出 Timetable 中调用同一份数据"],
    links: [{ label: "回到剧本锚点", target: "script" }, { label: "进入执行表", target: "planning" }],
  },
  people: {
    description: "集中管理角色、演员、部门与职责；其他模块引用同一份人员数据。",
    bullets: ["角色与演员绑定", "部门、岗位与权限", "个人到场、任务和通知聚合"],
    links: [{ label: "查看角色场次", target: "table" }, { label: "查看本人日程", target: "planning" }],
  },
  milestones: {
    description: "用阶段和子里程碑组织项目周期，并汇总跨部门任务与关键事件的完成情况。",
    bullets: ["阶段与子里程碑", "关联节点、事件与任务", "完成率、风险与时间进度"],
    links: [{ label: "查看节点与事件", target: "events" }, { label: "打开甘特计划", target: "planning" }],
  },
  finance: {
    description: "首轮只示意预算、支出与项目对象的关系，不深入完整财务流程。",
    bullets: ["预算与实际支出", "关联 Task、物料和 Event", "按部门和项目阶段汇总"],
    links: [{ label: "查看实体物料", target: "materials" }, { label: "查看长线计划", target: "planning" }],
  },
  materials: {
    description: "管理道具、服装、设备、库存、借还和成本。",
    bullets: ["状态与存放位置", "关联场次、角色和 Event", "采购或制作 Task"],
    links: [{ label: "查看相关 Task", target: "tasks" }, { label: "查看财务关联", target: "finance" }],
  },
};

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "blue" | "amber" | "red" | "green" }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

function ProgressRing({ value }: { value: number }) {
  return <span className={styles.progressRing} style={{ "--progress": `${value * 3.6}deg` } as React.CSSProperties}><b>{value}%</b></span>;
}

function CollaborationCommentBox({ placeholder = "写下评论，可使用 @ 提及协作成员" }: { placeholder?: string }) {
  const [comment, setComment] = useState("");
  const [importance, setImportance] = useState<"normal" | "important">("normal");
  const [notifyMentioned, setNotifyMentioned] = useState(true);
  const [sent, setSent] = useState(false);
  function submit() {
    if (!comment.trim()) return;
    setSent(true);
    setComment("");
  }
  return <div className={styles.commentComposer}>
    <textarea value={comment} onChange={(event) => { setComment(event.target.value); setSent(false); }} placeholder={placeholder} rows={2} />
    <div><select value={importance} onChange={(event) => setImportance(event.target.value as "normal" | "important")} aria-label="评论重要程度"><option value="normal">普通评论</option><option value="important">重要 · 需要关注</option></select><label><input type="checkbox" checked={notifyMentioned} onChange={(event) => setNotifyMentioned(event.target.checked)} />通知 @ 提及的人</label><button type="button" onClick={submit} disabled={!comment.trim()}>发布</button></div>
    {sent && <small>评论已发布{notifyMentioned ? "，并已通知被提及成员" : ""}。</small>}
  </div>;
}

export default function PrototypeClient() {
  const [view, setView] = useState<View>("home");
  const role: Role = "制作人 / 舞监";
  const canManageProject = role === "制作人 / 舞监";
  const [currentProject, setCurrentProject] = useState<ProjectOption>(PROJECTS[0]);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [mobileSide, setMobileSide] = useState<"script" | "stage">("script");
  const [mobileHomeSheet, setMobileHomeSheet] = useState<"work" | "dashboard">("work");
  const [drawer, setDrawer] = useState<"event" | "task" | "milestone" | "cue" | "notification" | null>(null);
  const [planningView, setPlanningView] = useState<PlanningView>("calendar");
  const [eventWizard, setEventWizard] = useState(false);
  const [eventStep, setEventStep] = useState(1);
  const [published, setPublished] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [completedTasks, setCompletedTasks] = useState<string[]>(["t1"]);
  const [plannerItems, setPlannerItems] = useState<PlannerItem[]>(INITIAL_PLANNER_ITEMS);
  const [plannerCreate, setPlannerCreate] = useState<{ type: PlannerObjectType; date: string } | null>(null);
  const [milestones, setMilestones] = useState<MilestoneRecord[]>(INITIAL_MILESTONES);
  const [milestoneDraftDate, setMilestoneDraftDate] = useState<string | null>(null);
  const [templateCenterOpen, setTemplateCenterOpen] = useState(false);
  const [notificationComposerOpen, setNotificationComposerOpen] = useState(false);
  const [sentNotification, setSentNotification] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountPage, setAccountPage] = useState<AccountPage | null>(null);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [joinProjectOpen, setJoinProjectOpen] = useState(false);
  const [projectAvatarUrl, setProjectAvatarUrl] = useState<string | null>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const mobileRailRef = useRef<HTMLDivElement>(null);

  const meta = VIEW_META[view];
  const navForMobile = mobileSide === "script" ? SCRIPT_NAV : STAGE_NAV;
  const mobileArea = view === "home" ? "work" : VIEW_META[view].side;
  const roleInfo = roleHome[role];
  const contentClass = `${styles.shell} ${mobilePreview ? styles.previewMobile : ""} ${sidebarCollapsed ? styles.sidebarCollapsed : ""}`;
  const mobileLayout = mobilePreview || narrowViewport;

  useEffect(() => {
    const requestedView = new URLSearchParams(window.location.search).get("view");
    if (requestedView && requestedView in VIEW_META) setView(requestedView as View);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 680px)");
    const syncViewport = () => setNarrowViewport(query.matches);
    syncViewport();
    query.addEventListener("change", syncViewport);
    return () => query.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    function dismissOpenSurfaces(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (!target.closest('[data-dismiss-surface="project-menu"]')) setProjectMenuOpen(false);
      if (!target.closest('[data-dismiss-surface="avatar-menu"]')) setAvatarMenuOpen(false);
      if (!target.closest('[data-dismiss-surface="account-menu"]')) setAccountMenuOpen(false);
      if (!target.closest('[data-dismiss-surface="mobile-search"]')) setMobileSearchOpen(false);
      if (!target.closest('[data-dismiss-surface="detail-drawer"]')) setDrawer(null);
    }

    function dismissWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setProjectMenuOpen(false);
      setAvatarMenuOpen(false);
      setAccountMenuOpen(false);
      setMobileSearchOpen(false);
      setDrawer(null);
    }

    document.addEventListener("pointerdown", dismissOpenSurfaces);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOpenSurfaces);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, []);

  function go(next: View) {
    setView(next);
    setDrawer(null);
    const side = VIEW_META[next].side;
    if (side) setMobileSide(side);
  }

  function completeTask(id: string) {
    setCompletedTasks((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  }

  function moveMobileRail(direction: -1 | 1) {
    mobileRailRef.current?.scrollBy({ left: direction * 210, behavior: "smooth" });
  }

  function selectMobileArea(area: "work" | "script" | "stage") {
    if (area === "work") {
      setMobileHomeSheet("work");
      go("home");
      return;
    }

    setMobileSide(area);
    go(area === "script" ? "script" : "milestones");
  }

  const taskProgress = useMemo(() => Math.round((completedTasks.length / 4) * 100), [completedTasks]);

  return (
    <main className={styles.prototypeRoot}>
      <div className={styles.demoBar}>
        <span><strong>Backstage</strong> · UI/UX 产品框架演示</span>
        <span className={styles.demoHint}>模拟数据 · 不连接现有业务</span>
        <button type="button" onClick={() => setMobilePreview((v) => !v)} className={styles.demoButton}>
          {mobilePreview ? "返回桌面预览" : "切换手机预览"}
        </button>
      </div>

      {accountPage ? (
        <AccountCenter page={accountPage} setPage={setAccountPage} close={() => setAccountPage(null)} mobile={mobileLayout} />
      ) : (
      <div className={contentClass}>
        <header className={styles.topbar}>
          <div className={styles.brand}>
            <div className={styles.avatarControl} data-dismiss-surface="avatar-menu">
              <button
                type="button"
                className={styles.projectAvatarButton}
                onClick={() => { setAvatarMenuOpen((v) => !v); setProjectMenuOpen(false); setAccountMenuOpen(false); }}
                aria-label="项目头像设置"
                aria-expanded={avatarMenuOpen}
              >
                {projectAvatarUrl ? <img src={projectAvatarUrl} alt="" /> : <span>{currentProject.avatar}</span>}
                <i>＋</i>
              </button>
              {avatarMenuOpen && (
                <div className={`${styles.popoverMenu} ${styles.avatarPopover}`}>
                  <b>项目头像</b>
                  <small>管理员可以上传 JPG、PNG 或 WebP</small>
                  <label className={styles.uploadButton}>
                    上传新头像
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) setProjectAvatarUrl(URL.createObjectURL(file));
                        setAvatarMenuOpen(false);
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
            <button type="button" className={styles.brandName} onClick={() => go("home")} aria-label="返回我的工作">
              Backstage
            </button>
          </div>
          <div className={styles.contextControls}>
            <div className={styles.projectSwitcher} data-dismiss-surface="project-menu">
              <button
                type="button"
                className={styles.switcherButton}
                onClick={() => { setProjectMenuOpen((v) => !v); setAccountMenuOpen(false); setAvatarMenuOpen(false); }}
                aria-expanded={projectMenuOpen}
              >
                <span><small>{currentProject.organization}</small><b>{currentProject.name}</b></span>
                <i>⌄</i>
              </button>
              {projectMenuOpen && (
                <div className={`${styles.popoverMenu} ${styles.projectMenu}`}>
                  <button type="button" className={styles.personalCenterItem} onClick={() => { go("home"); setProjectMenuOpen(false); }}>
                    <span className={styles.menuAvatar}>林</span><span><b>个人中心</b><small>今天与我有关</small></span>
                  </button>
                  <p>已加入的项目</p>
                  {PROJECTS.map((project) => (
                    <button
                      type="button"
                      key={project.id}
                      className={currentProject.id === project.id ? styles.selectedProject : ""}
                      onClick={() => { setCurrentProject(project); setProjectAvatarUrl(null); setProjectMenuOpen(false); go("project"); }}
                    >
                      <span className={styles.menuAvatar}>{project.avatar}</span>
                      <span><b>{project.name}</b><small>{project.organization}</small></span>
                      {currentProject.id === project.id && <i>✓</i>}
                    </button>
                  ))}
                  <button type="button" className={styles.joinProjectButton} onClick={() => { setJoinProjectOpen(true); setProjectMenuOpen(false); }}>
                    <span>＋</span><b>加入项目</b>
                  </button>
                </div>
              )}
            </div>
            <div className={styles.roleDisplay} title="角色与部门由项目管理员分配">
              <span>当前角色</span><b>{role}</b><i>正职</i>
            </div>
          </div>
          <div className={styles.topActions}>
            <div className={`${styles.searchControl} ${mobileSearchOpen ? styles.searchExpanded : ""}`} data-dismiss-surface="mobile-search">
              <button
                type="button"
                className={styles.searchButton}
                aria-label={mobileSearchOpen ? "收起搜索" : "搜索全部内容"}
                aria-expanded={mobileSearchOpen}
                onClick={() => setMobileSearchOpen((open) => !open)}
              >
                <span className={styles.searchIcon}>⌕</span><span>搜索全部内容</span>
              </button>
              {mobileSearchOpen && <input autoFocus type="search" placeholder="搜索 Event、Task、人员…" aria-label="搜索关键词" />}
            </div>
            <button type="button" className={styles.notificationButton} onClick={() => go("notifications")} aria-label="通知，3 条重要通知">
              通知<span className={styles.unreadDot}>3</span>
            </button>
            <div className={styles.accountControl} data-dismiss-surface="account-menu">
              <button
                type="button"
                className={styles.avatarButton}
                aria-label="管理中心"
                aria-expanded={accountMenuOpen}
                onClick={() => { setAccountMenuOpen((v) => !v); setProjectMenuOpen(false); setAvatarMenuOpen(false); }}
              >林</button>
              {accountMenuOpen && (
                <div className={`${styles.popoverMenu} ${styles.accountMenu}`}>
                  <div className={styles.accountSummary}><span>林</span><p><b>林淼</b><small>linmiao@click-in.cn</small></p></div>
                  {ACCOUNT_MENU_ITEMS.slice(0, 3).map((item) => (
                    <button type="button" key={item.id} onClick={() => { setAccountMenuOpen(false); setAccountPage(item.id); }}>
                      {item.label}<span>›</span>
                    </button>
                  ))}
                  {canManageProject && (
                    <button type="button" className={styles.deferredAdminButton} onClick={() => { setAccountMenuOpen(false); setAccountPage("adminPeople"); }}>
                      <span>管理后台<small>人员权限 · 预算</small></span><span>›</span>
                    </button>
                  )}
                  {ACCOUNT_MENU_ITEMS.slice(3).map((item) => (
                    <button type="button" key={item.id} onClick={() => { setAccountMenuOpen(false); setAccountPage(item.id); }}>
                      {item.label}<span>›</span>
                    </button>
                  ))}
                  <button type="button" className={styles.logoutButton} onClick={() => setAccountMenuOpen(false)}>退出登录</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <aside className={styles.sidebar} aria-label="主导航侧栏">
          <div className={styles.sidebarControls}>
            <span>导航</span>
            <button
              type="button"
              className={styles.sidebarToggle}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              aria-label={sidebarCollapsed ? "展开左侧边栏" : "折叠左侧边栏"}
              aria-expanded={!sidebarCollapsed}
              title={sidebarCollapsed ? "展开左侧边栏" : "折叠左侧边栏"}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="2.5" y="3" width="15" height="14" rx="2" />
                <path d="M7 3v14M12.5 7.5 10 10l2.5 2.5" />
              </svg>
            </button>
          </div>
          <nav aria-label="产品导航">
            <div className={`${styles.navGroup} ${styles.overviewGroup}`}>
              <div className={styles.navGroupTitle}><span className={styles.overviewDot} /><span>项目总览</span></div>
              <button type="button" title={sidebarCollapsed ? "我的工作" : undefined} className={`${styles.navItem} ${view === "home" ? styles.activeNav : ""}`} onClick={() => go("home")}>
                <span className={styles.navSymbol}>{NAV_GLYPHS.home}</span><span><b>我的工作</b><small>今日工作与协作</small></span>
              </button>
              <button type="button" title={sidebarCollapsed ? currentProject.name : undefined} className={`${styles.navItem} ${view === "project" ? styles.activeNav : ""}`} onClick={() => go("project")}>
                <span className={styles.navSymbol}>{NAV_GLYPHS.project}</span><span><b>{currentProject.name}</b><small>项目仪表盘</small></span>
              </button>
            </div>

            <div className={`${styles.navGroup} ${styles.scriptGroup}`}>
              <div className={styles.navGroupTitle}><span className={styles.scriptDot} /><span>创作侧</span></div>
              {SCRIPT_NAV.map((item) => (
                <button key={item.id} type="button" title={sidebarCollapsed ? item.label : undefined} className={`${styles.navItem} ${view === item.id ? styles.activeNav : ""}`} onClick={() => go(item.id)}>
                  <span className={`${styles.navSymbol} ${styles.scriptSymbol}`}>{NAV_GLYPHS[item.id]}</span><span><b>{item.label}</b><small>{item.hint}</small></span>
                </button>
              ))}
            </div>

            <div className={`${styles.navGroup} ${styles.stageGroup}`}>
              <div className={styles.navGroupTitle}><span className={styles.stageDot} /><span>制作侧</span></div>
              {STAGE_NAV.map((item) => (
                <button key={item.id} type="button" title={sidebarCollapsed ? item.label : undefined} className={`${styles.navItem} ${view === item.id ? styles.activeNav : ""}`} onClick={() => go(item.id)}>
                  <span className={`${styles.navSymbol} ${styles.stageSymbol}`}>{NAV_GLYPHS[item.id]}</span><span><b>{item.label}</b><small>{item.hint}</small></span>
                  {item.id === "notifications" && <em>3</em>}
                </button>
              ))}
            </div>
          </nav>
          <button type="button" title={sidebarCollapsed ? "产品框架说明" : undefined} className={`${styles.frameworkButton} ${view === "framework" ? styles.activeNav : ""}`} onClick={() => go("framework")}>
            <span>ⓘ</span><span><b>产品框架说明</b><small>交互规则与优先级</small></span>
          </button>
        </aside>

        <section className={styles.mobileProjectNav}>
          <div className={styles.segmented}>
            <button type="button" aria-pressed={mobileArea === "work"} onClick={() => selectMobileArea("work")}>项目总览</button>
            <button type="button" aria-pressed={mobileArea === "script"} onClick={() => selectMobileArea("script")}>创作侧</button>
            <button type="button" aria-pressed={mobileArea === "stage"} onClick={() => selectMobileArea("stage")}>制作侧</button>
          </div>
          {mobileArea === "work" && (
            <div className={styles.mobileHomeSheets} role="tablist" aria-label="我的工作视图">
              <button type="button" role="tab" aria-selected={mobileHomeSheet === "work"} onClick={() => setMobileHomeSheet("work")}>我的工作</button>
              <button type="button" role="tab" aria-selected={mobileHomeSheet === "dashboard"} onClick={() => setMobileHomeSheet("dashboard")}>项目仪表盘</button>
            </div>
          )}
          {mobileArea !== "work" && (
            <div className={styles.mobileRailShell}>
              <button type="button" className={styles.railArrow} onClick={() => moveMobileRail(-1)} aria-label="向左查看更多模块">‹</button>
              <div className={styles.mobileModuleRail} ref={mobileRailRef}>
                {navForMobile.map((item) => (
                  <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => go(item.id)}>{item.label}</button>
                ))}
              </div>
              <button type="button" className={styles.railArrow} onClick={() => moveMobileRail(1)} aria-label="向右查看更多模块">›</button>
            </div>
          )}
        </section>

        <section className={styles.workspace}>
          <div className={styles.pageHeader}>
            <div>
              {view !== "project" && <p className={`${styles.eyebrow} ${view === "home" ? styles.homeDateEyebrow : ""}`}>{view === "home" ? "2026 年 7 月 20 日 · 周一" : meta.eyebrow}</p>}
              <h1>{view === "project" ? currentProject.name : meta.label}</h1>
            </div>
            <div className={styles.headerActions}>
              {view === "home" && (
                <div className={styles.homeHeaderMeta} aria-label="今日项目概况">
                  <span><b>联排期</b><small>项目阶段</small></span>
                  <span><b>24 天</b><small>距首演</small></span>
                  <span><b>18 人</b><small>项目人员</small></span>
                </div>
              )}
              {view === "events" && <button type="button" className={styles.primaryButton} onClick={() => { setEventWizard(true); setEventStep(1); }}>＋ 创建 Event</button>}
              {view === "milestones" && <button type="button" className={styles.primaryButton} onClick={() => setMilestoneDraftDate("2026-07-20")}>＋ 新建里程碑</button>}
              {view === "tasks" && <button type="button" className={styles.primaryButton} onClick={() => setPlannerCreate({ type: "task", date: "2026-07-20" })}>＋ 新建 Task</button>}
              {view === "notifications" && <button type="button" className={styles.primaryButton} onClick={() => setNotificationComposerOpen(true)}>＋ 新建通知</button>}
              {view === "planning" && <button type="button" className={styles.primaryButton} onClick={() => setPlannerCreate({ type: "event", date: "2026-07-20" })}>＋ 新建计划</button>}
              {["milestones", "events", "tasks", "planning"].includes(view) && <button type="button" className={styles.secondaryButton} onClick={() => setTemplateCenterOpen(true)}>模板与字段</button>}
            </div>
          </div>

          {view === "home" && (!mobileLayout || mobileHomeSheet === "work" ? <HomeView role={role} roleInfo={roleInfo} go={go} setDrawer={setDrawer} acknowledged={acknowledged} /> : <ProjectView go={go} compact />)}
          {view === "project" && <ProjectView go={go} />}
          {view === "script" && <ScriptWorkspace go={go} />}
          {view === "dramaturgy" && <DramaturgyWorkspace go={go} />}
          {view === "cue" && <CueWorkspace go={go} setDrawer={setDrawer} />}
          {moduleCopy[view] && !["script", "dramaturgy", "cue", "milestones", "finance"].includes(view) && <ModuleView view={view} data={moduleCopy[view]!} go={go} setDrawer={setDrawer} />}
          {view === "finance" && <FinanceApprovalView />}
          {view === "milestones" && <MilestonesView records={milestones} setRecords={setMilestones} openCreate={setMilestoneDraftDate} />}
          {view === "events" && <EventsView published={published} openWizard={() => { setEventWizard(true); setEventStep(1); }} setDrawer={setDrawer} go={go} />}
          {view === "tasks" && <TasksView items={plannerItems} completed={completedTasks} completeTask={completeTask} progress={taskProgress} setDrawer={setDrawer} go={go} openCreate={() => setPlannerCreate({ type: "task", date: "2026-07-20" })} />}
          {view === "notifications" && <NotificationsView acknowledged={acknowledged} setAcknowledged={setAcknowledged} setDrawer={setDrawer} openCompose={() => setNotificationComposerOpen(true)} sentNotification={sentNotification} />}
          {view === "planning" && <PlanningViewPanel mode={planningView} setMode={setPlanningView} setDrawer={setDrawer} items={plannerItems} openCreate={(type, date) => setPlannerCreate({ type, date })} />}
          {view === "framework" && <FrameworkView go={go} />}
        </section>

        {drawer && <DetailDrawer type={drawer} close={() => setDrawer(null)} acknowledged={acknowledged} setAcknowledged={setAcknowledged} completeTask={completeTask} completed={completedTasks} />}

      </div>
      )}

      {!accountPage && eventWizard && (
        <EventWizard
          step={eventStep}
          setStep={setEventStep}
          close={() => setEventWizard(false)}
          publish={() => { setPublished(true); setEventWizard(false); setAcknowledged(false); }}
        />
      )}
      {!accountPage && plannerCreate && <PlannerCreateModal initialType={plannerCreate.type} initialDate={plannerCreate.date} close={() => setPlannerCreate(null)} create={(item, notify) => { setPlannerItems((current) => [...current, item]); if (notify) setSentNotification(`已向相关参与人发送“${item.title}”通知`); setPlannerCreate(null); }} />}
      {!accountPage && milestoneDraftDate && <MilestoneQuickModal initialDate={milestoneDraftDate} close={() => setMilestoneDraftDate(null)} create={(record, notify) => { setMilestones((current) => [...current, record]); if (notify) setSentNotification(`已向负责人及协作成员发送“${record.title}”通知`); setMilestoneDraftDate(null); }} />}
      {!accountPage && notificationComposerOpen && <NotificationComposerModal close={() => setNotificationComposerOpen(false)} send={(title, recipients) => { setSentNotification(`“${title}”已发送给 ${recipients}`); setNotificationComposerOpen(false); }} />}
      {!accountPage && templateCenterOpen && <TemplateCenterModal close={() => setTemplateCenterOpen(false)} />}
      {!accountPage && joinProjectOpen && <JoinProjectModal close={() => setJoinProjectOpen(false)} />}
    </main>
  );
}

function AccountCenter({
  page,
  setPage,
  close,
  mobile,
}: {
  page: AccountPage;
  setPage: (page: AccountPage) => void;
  close: () => void;
  mobile: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const [twoFactor, setTwoFactor] = useState(true);
  const [desktopAlerts, setDesktopAlerts] = useState(true);
  const [weeklyDigest, setWeeklyDigest] = useState(false);
  const [activityVisible, setActivityVisible] = useState(true);
  const [presenceVisible, setPresenceVisible] = useState(false);
  const isAdmin = page === "adminPeople" || page === "adminBudget";

  const pageMeta: Record<AccountPage, { eyebrow: string; title: string; description: string }> = {
    profile: { eyebrow: "ACCOUNT", title: "个人信息", description: "管理你的基础资料，以及在项目协作中向其他成员展示的信息。" },
    security: { eyebrow: "SECURITY", title: "账号安全中心", description: "检查登录方式、双重验证和当前登录设备。" },
    preferences: { eyebrow: "PREFERENCES", title: "功能与设置", description: "调整语言、界面密度以及消息提醒方式。" },
    privacy: { eyebrow: "PRIVACY", title: "信息隐私与权限", description: "决定哪些账户信息和协作状态可以被其他成员看到。" },
    help: { eyebrow: "SUPPORT", title: "帮助与反馈", description: "查找使用说明，或把你的问题与建议发送给产品团队。" },
    adminPeople: { eyebrow: "ADMIN · PEOPLE & ACCESS", title: "人员与权限管理", description: "管理项目成员、角色组及不同岗位对功能与数据的访问范围。" },
    adminBudget: { eyebrow: "ADMIN · BUDGET", title: "预算管理", description: "查看项目预算、部门额度、实际支出与待审批金额。" },
  };

  function saveChanges() {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  }

  const toggle = (value: boolean, setValue: (value: boolean) => void, label: string) => (
    <button
      type="button"
      className={`${styles.settingsToggle} ${value ? styles.settingsToggleOn : ""}`}
      aria-pressed={value}
      aria-label={label}
      onClick={() => setValue(!value)}
    >
      <span />
    </button>
  );

  return (
    <section className={`${styles.accountSettingsShell} ${isAdmin ? styles.adminSettingsShell : styles.personalSettingsShell} ${mobile ? styles.accountSettingsMobile : ""}`}>
      <header className={styles.accountSettingsTopbar}>
        <button type="button" className={styles.settingsBackButton} onClick={close}>
          <span>←</span> 返回工作区
        </button>
        <div className={styles.accountSettingsBrand}><i>{isAdmin ? "管" : "林"}</i><b>Backstage</b><span>{isAdmin ? "管理后台" : "个人中心"}</span></div>
        <div className={styles.accountSettingsUser}><span>{isAdmin ? "管理员视图 · 林淼" : "林淼"}</span><i>林</i></div>
      </header>

      <div className={`${styles.accountSettingsLayout} ${isAdmin ? styles.adminSettingsLayout : ""}`}>
        <aside className={styles.settingsSidebar}>
          <div className={styles.settingsIdentity}>
            <span>{isAdmin ? "海" : "林"}</span>
            <p><b>{isAdmin ? "海边的罗密欧" : "林淼"}</b><small>{isAdmin ? "项目管理后台" : "linmiao@click-in.cn"}</small></p>
          </div>
          <nav aria-label={isAdmin ? "管理后台导航" : "个人中心导航"}>
            {isAdmin ? (
              <>
                <p>项目治理</p>
                <button type="button" className={page === "adminPeople" ? styles.settingsNavActive : ""} onClick={() => setPage("adminPeople")}><span>权</span>人员与权限管理</button>
                <button type="button" className={page === "adminBudget" ? styles.settingsNavActive : ""} onClick={() => setPage("adminBudget")}><span>¥</span>预算管理</button>
              </>
            ) : (
              <>
                <p>账户</p>
                {ACCOUNT_MENU_ITEMS.slice(0, 2).map((item) => (
                  <button type="button" key={item.id} className={page === item.id ? styles.settingsNavActive : ""} onClick={() => setPage(item.id)}>
                    <span>{item.id === "profile" ? "人" : "盾"}</span>{item.label}
                  </button>
                ))}
                <p>偏好与隐私</p>
                {ACCOUNT_MENU_ITEMS.slice(2, 4).map((item) => (
                  <button type="button" key={item.id} className={page === item.id ? styles.settingsNavActive : ""} onClick={() => setPage(item.id)}>
                    <span>{item.id === "preferences" ? "调" : "锁"}</span>{item.label}
                  </button>
                ))}
                <p>支持</p>
                <button type="button" className={page === "help" ? styles.settingsNavActive : ""} onClick={() => setPage("help")}><span>?</span>帮助与反馈</button>
              </>
            )}
          </nav>
          <div className={styles.settingsWorkspaceNote}>
            <b>{isAdmin ? "访问范围" : "当前工作区"}</b>
            <span>{isAdmin ? "仅项目管理员可见" : "海边的罗密欧"}</span>
            <small>{isAdmin ? "无管理权限的成员不会看到此入口或页面" : "个人设置对所有项目生效"}</small>
          </div>
        </aside>

        <main className={styles.settingsMain}>
          <div className={styles.settingsPageHeader}>
            <p>{pageMeta[page].eyebrow}</p>
            <h1>{pageMeta[page].title}</h1>
            <span>{pageMeta[page].description}</span>
          </div>

          {page === "profile" && (
            <>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>公开资料</h2><p>这些信息会出现在项目成员、任务和 Event 中。</p></div></div>
                <div className={styles.profileEditor}>
                  <div className={styles.settingsFormGrid}>
                    <label><span>姓名</span><input defaultValue="林淼" /></label>
                    <label><span>所在城市</span><input defaultValue="上海" /></label>
                    <label><span>显示名称</span><input defaultValue="林淼 · 舞监" /></label>
                    <label><span>联系电话</span><input defaultValue="+86 138 **** 6812" /></label>
                    <label className={styles.settingsFullField}><span>个人简介</span><textarea defaultValue="制作人 / 舞台监督，负责跨部门排练协调与现场执行。" /></label>
                  </div>
                  <div className={styles.settingsAvatarEditor}>
                    <span>林</span>
                    <button type="button">更换头像</button>
                    <small>JPG、PNG 或 WebP<br />最大 5 MB</small>
                  </div>
                </div>
              </section>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>账户邮箱</h2><p>用于登录、接收安全提醒和找回账号。</p></div><Badge tone="green">已验证</Badge></div>
                <label className={styles.settingsInlineField}><span>主邮箱</span><input defaultValue="linmiao@click-in.cn" /><button type="button">更换邮箱</button></label>
              </section>
            </>
          )}

          {page === "security" && (
            <>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>密码与验证</h2><p>最近一次修改密码：2026 年 5 月 18 日</p></div><button type="button" className={styles.settingsOutlineButton}>修改密码</button></div>
                <div className={styles.settingsPreferenceRow}>
                  <div><b>双重验证</b><span>登录时需要密码和验证器动态码。</span></div>
                  <div className={styles.settingsRowAction}><Badge tone="green">推荐</Badge>{toggle(twoFactor, setTwoFactor, "双重验证")}</div>
                </div>
                <div className={styles.settingsPreferenceRow}>
                  <div><b>恢复方式</b><span>已保存 8 组恢复代码 · 安全邮箱已验证</span></div>
                  <button type="button" className={styles.settingsTextButton}>管理恢复方式</button>
                </div>
              </section>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>登录设备</h2><p>如发现陌生设备，请立即退出并修改密码。</p></div></div>
                <div className={styles.sessionRow}><span>桌</span><div><b>Windows · Chrome</b><small>上海 · 当前设备 · 刚刚活跃</small></div><Badge tone="green">当前</Badge></div>
                <div className={styles.sessionRow}><span>手</span><div><b>iPhone · Backstage App</b><small>上海 · 7 月 27 日 22:18</small></div><button type="button" className={styles.settingsTextButton}>退出</button></div>
              </section>
            </>
          )}

          {page === "preferences" && (
            <>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>界面偏好</h2><p>设置将同步至你登录的所有设备。</p></div></div>
                <div className={styles.settingsFormGrid}>
                  <label><span>语言</span><select defaultValue="zh"><option value="zh">简体中文</option><option value="en">English</option></select></label>
                  <label><span>时区</span><select defaultValue="sh"><option value="sh">(UTC+08:00) 上海</option><option value="ld">(UTC+00:00) 伦敦</option></select></label>
                  <label><span>界面主题</span><select defaultValue="system"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
                  <label><span>信息密度</span><select defaultValue="comfortable"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
                </div>
              </section>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>消息提醒</h2><p>控制跨项目通知的送达方式。</p></div></div>
                <div className={styles.settingsPreferenceRow}><div><b>桌面提醒</b><span>重要 Task、Event 变更与 @提及</span></div>{toggle(desktopAlerts, setDesktopAlerts, "桌面提醒")}</div>
                <div className={styles.settingsPreferenceRow}><div><b>每周工作摘要</b><span>每周一上午汇总待办、风险与里程碑</span></div>{toggle(weeklyDigest, setWeeklyDigest, "每周工作摘要")}</div>
              </section>
            </>
          )}

          {page === "privacy" && (
            <>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>协作可见性</h2><p>项目管理员仍可按组织政策查看必要的审计信息。</p></div></div>
                <div className={styles.settingsPreferenceRow}><div><b>展示协作动态</b><span>允许同项目成员查看你最近更新的 Task 与文件。</span></div>{toggle(activityVisible, setActivityVisible, "展示协作动态")}</div>
                <div className={styles.settingsPreferenceRow}><div><b>展示在线状态</b><span>在头像旁显示当前在线或离开状态。</span></div>{toggle(presenceVisible, setPresenceVisible, "展示在线状态")}</div>
              </section>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>数据与授权</h2><p>管理个人数据副本和第三方应用访问。</p></div></div>
                <div className={styles.settingsPreferenceRow}><div><b>导出个人数据</b><span>生成你的个人资料、评论与操作记录副本。</span></div><button type="button" className={styles.settingsOutlineButton}>申请导出</button></div>
                <div className={styles.settingsPreferenceRow}><div><b>已授权应用</b><span>当前没有第三方应用访问你的 Backstage 账号。</span></div><button type="button" className={styles.settingsTextButton}>查看详情</button></div>
              </section>
            </>
          )}

          {page === "help" && (
            <>
              <section className={`${styles.settingsCard} ${styles.helpSearchCard}`}>
                <h2>有什么可以帮你？</h2>
                <label><span>⌕</span><input type="search" placeholder="搜索功能、操作说明或常见问题" /></label>
                <div className={styles.helpQuickLinks}>
                  <button type="button"><b>入门指南</b><span>创建项目与加入团队</span></button>
                  <button type="button"><b>协作手册</b><span>Event、Task 与通知</span></button>
                  <button type="button"><b>账号问题</b><span>登录、安全与权限</span></button>
                </div>
              </section>
              <section className={styles.settingsCard}>
                <div className={styles.settingsCardTitle}><div><h2>发送反馈</h2><p>描述你遇到的问题或希望加入的能力。</p></div></div>
                <div className={styles.settingsFormGrid}>
                  <label><span>反馈类型</span><select><option>产品建议</option><option>使用问题</option><option>故障报告</option></select></label>
                  <label><span>回复邮箱</span><input defaultValue="linmiao@click-in.cn" /></label>
                  <label className={styles.settingsFullField}><span>详细描述</span><textarea placeholder="请尽量说明操作路径、预期结果和实际结果…" /></label>
                </div>
              </section>
            </>
          )}

          {page === "adminPeople" && <AdminPeoplePanel />}
          {page === "adminBudget" && <AdminBudgetPanel />}

          <div className={styles.settingsActions}>
            <span>{saved ? "✓ 更改已保存" : isAdmin ? "管理操作将记录到项目审计日志" : "设置仅影响你的个人账户"}</span>
            <button type="button" onClick={saveChanges}>{page === "help" ? "发送反馈" : isAdmin ? "保存后台设置" : "保存更改"}</button>
          </div>
        </main>
      </div>
    </section>
  );
}

function AdminPeoplePanel() {
  const members = [
    ["林淼", "制作人 / 舞监", "管理组", "管理员", "正常"],
    ["陈洛华", "演员", "演员组", "成员", "正常"],
    ["王恺镔", "灯光设计", "灯光组", "部门负责人", "正常"],
    ["周嘉", "音响设计", "音响组", "部门负责人", "正常"],
    ["韩松", "多媒体", "多媒体组", "成员", "待加入"],
  ];
  return <div className={styles.adminStack}>
    <section className={styles.adminStats} aria-label="人员概况"><div><b>18</b><span>项目成员</span><small>较上周 +2</small></div><div><b>7</b><span>角色组</span><small>覆盖全部部门</small></div><div><b>4</b><span>管理员</span><small>2 位预算审批人</small></div><div><b>1</b><span>待处理邀请</span><small>多媒体组</small></div></section>
    <section className={styles.settingsCard}><div className={styles.adminToolbar}><div><h2>项目成员</h2><p>按人员、部门或角色组配置访问范围。</p></div><label><span>⌕</span><input type="search" placeholder="搜索姓名、职务或部门" /></label><button type="button" className={styles.settingsOutlineButton}>＋ 邀请成员</button></div><div className={styles.adminTable}><div className={styles.adminTableHead}><span>成员</span><span>职务</span><span>角色组</span><span>权限级别</span><span>状态</span><span /></div>{members.map(([name, job, group, access, status]) => <div key={name}><span className={styles.adminMember}><i>{name.slice(0, 1)}</i><b>{name}</b></span><span>{job}</span><span>{group}</span><span><button type="button" className={styles.adminAccessButton}>{access}⌄</button></span><span><Badge tone={status === "正常" ? "green" : "amber"}>{status}</Badge></span><button type="button" aria-label={`管理 ${name}`}>•••</button></div>)}</div></section>
    <section className={styles.settingsCard}><div className={styles.settingsCardTitle}><div><h2>权限模板</h2><p>用类似功能套餐的方式快速比较岗位权限。</p></div><button type="button" className={styles.settingsTextButton}>配置模板 →</button></div><div className={styles.permissionPlans}><div><b>成员</b><span>查看项目内容</span><span>更新自己的 Task</span><em>不可配置他人</em></div><div><b>部门负责人</b><span>成员全部权限</span><span>管理本部门数据</span><span>编辑部门 Rundown</span></div><div className={styles.permissionPlanFeatured}><b>管理员</b><span>项目全部权限</span><span>成员与角色配置</span><span>预算审批与审计</span></div></div></section>
  </div>;
}

function AdminBudgetPanel() {
  const departments = [["舞美制作", "¥ 420,000", "¥ 286,400", "68%"], ["灯光", "¥ 180,000", "¥ 112,800", "63%"], ["音响", "¥ 120,000", "¥ 54,600", "46%"], ["多媒体", "¥ 150,000", "¥ 128,700", "86%"], ["服化", "¥ 210,000", "¥ 96,300", "46%"]];
  const [tableMode, setTableMode] = useState<"detail" | "department">("detail");
  const [departmentFilter, setDepartmentFilter] = useState("全部部门");
  const [phaseFilter, setPhaseFilter] = useState("全部阶段");
  const [statusFilter, setStatusFilter] = useState("全部状态");
  const [budgetSearch, setBudgetSearch] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const filteredRecords = useMemo(() => BUDGET_RECORDS.filter((record) => {
    const matchesDepartment = departmentFilter === "全部部门" || record.department === departmentFilter;
    const matchesPhase = phaseFilter === "全部阶段" || record.phase === phaseFilter;
    const matchesStatus = statusFilter === "全部状态" || record.status === statusFilter;
    const keyword = budgetSearch.trim().toLowerCase();
    const matchesSearch = !keyword || [record.item, record.code, record.task, record.category, record.owner].some((value) => value.toLowerCase().includes(keyword));
    return matchesDepartment && matchesPhase && matchesStatus && matchesSearch;
  }), [departmentFilter, phaseFilter, statusFilter, budgetSearch]);
  const visibleBudget = filteredRecords.reduce((sum, record) => sum + record.budget, 0);
  const visibleActual = filteredRecords.reduce((sum, record) => sum + record.actual, 0);
  const money = (value: number) => `¥ ${value.toLocaleString("zh-CN")}`;
  const statusTone = (status: BudgetStatus): "neutral" | "blue" | "amber" | "red" | "green" => status === "已支付" ? "green" : status === "超预算" ? "red" : status === "待复核" || status === "待填报" ? "amber" : status === "已批准" ? "blue" : "neutral";

  return <div className={styles.adminStack}>
    <section className={styles.budgetHero}><div><span>项目总预算</span><b>¥ 1,280,000</b><small>《海边的罗密欧》· 2026 制作期</small></div><div><span>已使用</span><b>¥ 742,600</b><i><em style={{ width: "58%" }} /></i><small>58% · 进度在预算内</small></div><div><span>待审批</span><b>¥ 86,400</b><small>7 笔申请 · 2 笔高优先级</small></div></section>

    <section className={styles.budgetEntryGuide}>
      <div><p>预算填报规范</p><h2>提交人负责说明“买什么、为什么、多少钱”</h2><span>财务与管理者在同一张明细表里复核、追踪采购和实际支出。</span></div>
      <div className={styles.budgetFieldGuide}>
        <span><b>01 归属</b><small>阶段 · 部门 · 主任务</small></span><span><b>02 预算</b><small>费用类型 · 数量 · 单位 · 单价</small></span><span><b>03 采购</b><small>渠道 · 期望日期 · 报价链接</small></span><span><b>04 责任</b><small>填报人 · 负责人 · 备注</small></span>
      </div>
      <button type="button" onClick={() => { setDraftOpen((open) => !open); setDraftSaved(false); }}>{draftOpen ? "收起填报" : "＋ 填报预算"}</button>
    </section>

    {draftOpen && <form className={`${styles.settingsCard} ${styles.budgetEntryCard}`} onSubmit={(event) => { event.preventDefault(); setDraftSaved(true); }}>
      <div className={styles.settingsCardTitle}><div><h2>新建预算项</h2><p>带 * 的字段由需求发起人填写；预算总价由数量 × 单价自动计算。</p></div>{draftSaved && <Badge tone="green">草稿已保存</Badge>}</div>
      <div className={styles.budgetEntryGrid}>
        <label><span>预算项目名称 *</span><input required placeholder="例如：第三幕海浪投影素材授权" /></label>
        <label><span>项目阶段 *</span><select required defaultValue=""><option value="" disabled>选择阶段</option><option>筹备期</option><option>制作期</option><option>联排期</option><option>演出期</option></select></label>
        <label><span>部门 *</span><select required defaultValue=""><option value="" disabled>选择部门</option><option>舞美制作</option><option>灯光</option><option>音响</option><option>多媒体</option><option>导演组</option></select></label>
        <label><span>主任务 / 预算包 *</span><input required placeholder="例如：第三幕技术闭环" /></label>
        <label><span>费用类型 *</span><select required defaultValue=""><option value="" disabled>选择费用类型</option><option>资料打印</option><option>舞台材料</option><option>版权授权</option><option>书本资料</option><option>人工运费</option></select></label>
        <label><span>数量与单位 *</span><span className={styles.budgetCompoundField}><input required type="number" min="1" defaultValue="1" /><select defaultValue="项"><option>项</option><option>份</option><option>本</option><option>套</option><option>天</option></select></span></label>
        <label><span>预算单价 *</span><input required type="number" min="0" placeholder="¥ 0.00" /></label>
        <label><span>期望到位日期 *</span><input required type="date" defaultValue="2026-07-25" /></label>
        <label><span>采购渠道</span><select defaultValue="待选择"><option>待选择</option><option>电商采购</option><option>询价采购</option><option>线下供应商</option><option>个人服务</option></select></label>
        <label><span>预算负责人 *</span><input required defaultValue="林淼" /></label>
        <label className={styles.budgetWideField}><span>报价 / 商品链接与备注</span><textarea placeholder="粘贴报价单或商品链接，并说明规格、用途及替代方案…" /></label>
      </div>
      <div className={styles.budgetEntryActions}><span>提交后进入“待复核”，财务可补充实际支出、付款记录和凭证。</span><button type="button" onClick={() => setDraftOpen(false)}>取消</button><button type="submit">保存草稿</button></div>
    </form>}

    <section className={`${styles.settingsCard} ${styles.budgetManagerCard}`}>
      <div className={styles.adminToolbar}><div><h2>预算管理表</h2><p>财务核对预算、采购与实际发生；共 {filteredRecords.length} 项，当前预算 {money(visibleBudget)} / 实际 {money(visibleActual)}。</p></div><button type="button" className={styles.settingsOutlineButton}>导出当前视图</button><button type="button" className={styles.settingsOutlineButton} onClick={() => setDraftOpen(true)}>＋ 新建预算项</button></div>
      <div className={styles.budgetViewTabs}><button type="button" aria-pressed={tableMode === "detail"} onClick={() => setTableMode("detail")}>全部明细</button><button type="button" aria-pressed={tableMode === "department"} onClick={() => setTableMode("department")}>按部门汇总</button></div>
      <div className={styles.budgetFilters}>
        <label><span>⌕</span><input type="search" value={budgetSearch} onChange={(event) => setBudgetSearch(event.target.value)} placeholder="搜索项目、编号、任务或负责人" /></label>
        <select aria-label="筛选部门" value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option>全部部门</option>{[...new Set(BUDGET_RECORDS.map((record) => record.department))].map((value) => <option key={value}>{value}</option>)}</select>
        <select aria-label="筛选阶段" value={phaseFilter} onChange={(event) => setPhaseFilter(event.target.value)}><option>全部阶段</option>{[...new Set(BUDGET_RECORDS.map((record) => record.phase))].map((value) => <option key={value}>{value}</option>)}</select>
        <select aria-label="筛选状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>全部状态</option>{[...new Set(BUDGET_RECORDS.map((record) => record.status))].map((value) => <option key={value}>{value}</option>)}</select>
        <button type="button" onClick={() => { setBudgetSearch(""); setDepartmentFilter("全部部门"); setPhaseFilter("全部阶段"); setStatusFilter("全部状态"); }}>重置</button>
      </div>
      {tableMode === "department" ? <div className={`${styles.adminTable} ${styles.budgetTable}`}><div className={styles.adminTableHead}><span>部门</span><span>预算</span><span>已使用</span><span>使用率</span><span /></div>{departments.map(([name, budget, used, percent]) => <div key={name}><span><b>{name}</b></span><span>{budget}</span><span>{used}</span><span className={styles.budgetUsage}><i><em style={{ width: percent }} /></i><b>{percent}</b></span><button type="button" aria-label={`查看 ${name} 预算`} onClick={() => { setDepartmentFilter(name); setTableMode("detail"); }}>→</button></div>)}</div> : <div className={styles.budgetLedgerWrap}><div className={styles.budgetLedger} role="table" aria-label="预算明细核对表">
        <div className={`${styles.budgetLedgerRow} ${styles.budgetLedgerHead}`} role="row"><span>预算项目 / 编号</span><span>阶段</span><span>部门</span><span>主任务</span><span>费用类型</span><span>数量</span><span>预算单价</span><span>预算总价</span><span>实际支出</span><span>采购渠道</span><span>状态 / 负责人</span></div>
        {filteredRecords.map((record) => <button type="button" className={styles.budgetLedgerRow} role="row" key={record.id}><span><b>{record.item}</b><small>{record.code}</small></span><span>{record.phase}</span><span>{record.department}</span><span>{record.task}</span><span><em>{record.category}</em></span><span>{record.quantity} {record.unit}</span><span>{money(record.unitPrice)}</span><span><b>{money(record.budget)}</b></span><span className={record.actual > record.budget ? styles.budgetOver : ""}>{money(record.actual)}</span><span>{record.channel}</span><span><Badge tone={statusTone(record.status)}>{record.status}</Badge><small>{record.owner}</small></span></button>)}
        {!filteredRecords.length && <div className={styles.budgetEmpty}>没有符合当前筛选条件的预算项。</div>}
      </div></div>}
    </section>
    <section className={styles.settingsCard}><div className={styles.settingsCardTitle}><div><h2>待审批</h2><p>近期需要预算负责人处理的申请。</p></div><Badge tone="amber">7</Badge></div><div className={styles.approvalRows}><button type="button"><span><b>海浪视频素材追加授权</b><small>多媒体组 · 韩松 · 今天 10:24</small></span><strong>¥ 18,000</strong><Badge tone="amber">待审批</Badge></button><button type="button"><span><b>舞台右侧护栏加固材料</b><small>舞美制作 · 徐宁 · 昨天 17:40</small></span><strong>¥ 32,600</strong><Badge>复核中</Badge></button></div></section>
  </div>;
}

function JoinProjectModal({ close }: { close: () => void }) {
  return (
    <div className={styles.modalBackdrop} role="presentation">
      <section className={`${styles.modal} ${styles.joinProjectModal}`} role="dialog" aria-modal="true" aria-labelledby="join-project-title">
        <div className={styles.modalHeader}>
          <div><p>JOIN A PROJECT</p><h2 id="join-project-title">加入项目</h2></div>
          <button type="button" onClick={close} aria-label="关闭">×</button>
        </div>
        <p className={styles.modalLead}>向项目管理员获取邀请码。加入后，项目与管理员分配的角色会出现在顶部切换器中。</p>
        <div className={styles.joinProjectBody}>
          <label><span>项目邀请码</span><input placeholder="例如：ROMEO-2026-08" /></label>
          <label><span>你的姓名</span><input defaultValue="林淼" /></label>
          <div className={styles.inviteHint}><span>i</span><p><b>角色不可自行选择</b><small>制作人、Owner 或项目管理员会在你加入后分配角色与部门。</small></p></div>
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.secondaryButton} onClick={close}>取消</button>
          <button type="button" className={styles.primaryButton} onClick={close}>验证邀请码</button>
        </div>
      </section>
    </div>
  );
}

function AiWorkAssistant({ go }: { go: (v: View) => void }) {
  const [input, setInput] = useState("");
  const [skill, setSkill] = useState<AiSkillId | "auto">("auto");
  const [lastQuestion, setLastQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);

  function applyTemplate(template: AiPromptTemplate) {
    setFocused(true);
    setSkill(template.id);
    setInput(template.prompt);
    setAnswer("");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || loading) return;
    setLastQuestion(message);
    setInput("");
    setAnswer("");
    setLoading(true);
    const response = await requestAiAssistant({ message, skill, context: { projectId: "sea-romeo", view: "home" } });
    setAnswer(response.message);
    setLoading(false);
  }

  return (
    <>
    {focused && <button type="button" className={styles.aiFocusBackdrop} onClick={() => !loading && setFocused(false)} aria-label="退出 AI 专注对话" />}
    <section className={`${styles.aiAssistant} ${focused ? styles.aiAssistantFocused : styles.aiAssistantCompact}`} aria-label="Backstage AI 工作助手">
      {focused && <header className={styles.aiFocusHeader}><div><i>AI</i><span><b>Backstage AI</b><small>{loading ? "正在调用项目上下文与所选能力" : "专注对话模式"}</small></span></div><button type="button" onClick={() => !loading && setFocused(false)} aria-label="关闭 AI 对话">×</button></header>}
      <div className={styles.aiPromptRail}>
        <div className={styles.aiPromptHeading}><span>AI 工作助手</span><small>选择模板，或直接描述你想完成的工作</small></div>
        <div className={styles.aiPromptTemplates}>
          {AI_PROMPT_TEMPLATES.map((template) => (
            <button type="button" key={template.id} data-skill={template.id} aria-pressed={skill === template.id} onClick={() => applyTemplate(template)}>
              <span>{template.label}</span><small>{template.description}</small><i>↗</i>
            </button>
          ))}
        </div>
      </div>
      <form className={styles.aiComposer} onSubmit={submit} onFocusCapture={() => setFocused(true)}>
        {(lastQuestion || answer || loading) && (
          <div className={styles.aiConversation} aria-live="polite">
            {lastQuestion && <p><span>你</span>{lastQuestion}</p>}
            <p className={styles.aiAnswer}><span>AI</span>{loading ? <><b className={styles.aiCallingState}>AI 正在调用</b><i className={styles.aiLoadingDots}>•••</i><small>正在分析当前项目、Task 与 Rundown 上下文</small></> : answer}</p>
          </div>
        )}
        <textarea value={input} onClick={() => setFocused(true)} onFocus={() => setFocused(true)} onChange={(event) => { setFocused(true); setInput(event.target.value); }} placeholder="询问项目进度、梳理任务或生成执行日程…" rows={2} aria-label="向 AI 工作助手提问" />
        <div className={styles.aiComposerFooter}>
          <button type="button" className={styles.aiIconButton} aria-label="添加上下文或附件">＋</button>
          <label><span>能力</span><select value={skill} onChange={(event) => setSkill(event.target.value as AiSkillId | "auto")}><option value="auto">自动选择</option>{AI_PROMPT_TEMPLATES.map((template) => <option value={template.id} key={template.id}>{template.label}</option>)}</select></label>
          <span className={styles.aiModelState}>Backstage AI · Demo</span>
          <button type="button" className={styles.aiVoiceButton} aria-label="语音输入">◉</button>
          <button type="submit" className={styles.aiSendButton} disabled={!input.trim() || loading} aria-label="发送给 AI">↑</button>
        </div>
        {answer && skill === "rundown-autoplan" && <button type="button" className={styles.aiResultAction} onClick={() => go("planning")}>打开计划与日程，继续编辑 Rundown →</button>}
      </form>
    </section>
    </>
  );
}

function HomeView({ role, roleInfo, go, setDrawer, acknowledged }: {
  role: Role;
  roleInfo: { focus: string; secondary: string; note: string };
  go: (v: View) => void;
  setDrawer: (v: "task" | "cue" | "notification") => void;
  acknowledged: boolean;
}) {
  return (
    <div className={`${styles.contentStack} ${styles.homeContentStack}`}>
      <section className={styles.dashboardHero}>
        <div className={styles.dashboardHeroIntro}>
          <Badge tone="blue">{role}</Badge>
          <span className={styles.dashboardHeroLabel}>TODAY&apos;S CONTROL DESK</span>
          <h2>{roleInfo.focus}</h2>
          <small>重点范围 · {roleInfo.secondary}</small>
        </div>
        <div className={styles.dashboardHeroData}>
          <div className={styles.dashboardMetrics}>
            <button type="button" onClick={() => go("notifications")}><strong>8</strong><span>待确认</span><small>较昨日 −3</small></button>
            <button type="button" onClick={() => go("tasks")}><strong>2</strong><span>风险任务</span><small>1 项今日截止</small></button>
            <button type="button" onClick={() => go("events")}><strong>24</strong><span>距首演 / 天</span><small>3 个关键事件</small></button>
          </div>
          <div className={styles.heroProjects}>
            <span>项目进度</span>
            <button type="button" onClick={() => go("project")}><b>海边的罗密欧</b><i><em style={{ width: "74%" }} /></i><strong>74%</strong></button>
            <button type="button"><b>茶馆</b><i><em style={{ width: "28%" }} /></i><strong>28%</strong></button>
          </div>
        </div>
      </section>
      <div className={styles.dashboardGrid}>
        <section className={`${styles.panel} ${styles.todayPanel}`}>
          <div className={styles.panelHeading}><div><p className={styles.kicker}>7 月 20 日 · 周一</p><h2>今天</h2></div><button type="button" onClick={() => go("planning")}>完整日程 →</button></div>
          <div className={styles.timelineList}>
            <button type="button" onClick={() => go("events")}><time>13:30</time><span><b>第三幕合成排练</b><small>黑匣子 B · Call 13:00</small></span><Badge tone="amber">必须确认</Badge></button>
            <button type="button" onClick={() => setDrawer("task")}><time>16:45</time><span><b>确认海浪视频最终版</b><small>多媒体组 · 截止今天</small></span><Badge tone="red">有风险</Badge></button>
            <button type="button" onClick={() => setDrawer("cue")}><time>19:20</time><span><b>LX 34–42 Cue 联调</b><small>灯光 / 音响 / 多媒体</small></span><Badge tone="blue">Cue</Badge></button>
          </div>
        </section>
        <section className={styles.panel}>
          <div className={styles.panelHeading}><div><p className={styles.kicker}>MY TASKS</p><h2>我的任务</h2></div><button type="button" onClick={() => go("tasks")}>全部 →</button></div>
          <div className={styles.compactList}>
            <button type="button" onClick={() => setDrawer("task")}><span className={styles.checkCircle}>○</span><span><b>确认第三幕转场动线</b><small>今天 · 关联 2 个 Event</small></span></button>
            <button type="button" onClick={() => setDrawer("task")}><span className={styles.checkCircle}>◐</span><span><b>舞台地胶采购与铺设</b><small>进行中 · 长线 Task</small></span></button>
            <button type="button" onClick={() => setDrawer("task")}><span className={styles.checkCircle}>○</span><span><b>首演 Call Sheet 复核</b><small>明天 · 需要 4 人确认</small></span></button>
          </div>
        </section>
        <section className={`${styles.panel} ${styles.actionPanel}`}>
          <div className={styles.panelHeading}><div><p className={styles.kicker}>ACTION REQUIRED</p><h2>待确认</h2></div><button type="button" onClick={() => go("notifications")}>通知中心 →</button></div>
          <button type="button" className={styles.noticeCard} onClick={() => setDrawer("notification")}>
            <span className={styles.noticeIcon}>!</span><span><b>第三幕排练改至 13:30</b><small>{acknowledged ? "你已确认 · 仍有 3 人未确认" : "需要你的确认 · 8 人未确认"}</small></span><Badge tone={acknowledged ? "green" : "amber"}>{acknowledged ? "已确认" : "确认"}</Badge>
          </button>
          <button type="button" className={styles.noticeCard} onClick={() => setDrawer("notification")}>
            <span className={styles.noticeIcon}>↗</span><span><b>你被指派了新的技术 Task</b><small>舞台右侧护栏加固 · 明天截止</small></span><Badge>查看</Badge>
          </button>
        </section>
        <section className={`${styles.panel} ${styles.eventRoadmapPanel}`}>
          <div className={styles.panelHeading}><div><p className={styles.kicker}>KEY EVENTS</p><h2>关键事件</h2></div><button type="button" onClick={() => go("events")}>全部 →</button></div>
          <div className={styles.eventRoadmap}>
            <button type="button" onClick={() => go("events")}><time><b>20</b><small>7 月</small></time><span><b>第三幕合成排练</b><small>今天 · 13:30 · 黑匣子 B</small></span><em>进行中</em></button>
            <button type="button" onClick={() => go("events")}><time><b>27</b><small>7 月</small></time><span><b>第一次全本联排</b><small>7 天后 · 排练厅 A</small></span><em>待准备</em></button>
            <button type="button" onClick={() => go("events")}><time><b>13</b><small>8 月</small></time><span><b>首演</b><small>24 天后 · 城市剧院</small></span><em>里程碑</em></button>
          </div>
        </section>
      </div>
      <AiWorkAssistant go={go} />
    </div>
  );
}

function ProjectView({ go, compact = false }: { go: (v: View) => void; compact?: boolean }) {
  return (
    <div className={`${styles.contentStack} ${compact ? styles.projectDashboardCompact : ""}`}>
      <section className={styles.projectHero}>
        <div><Badge tone="green">联排期 · 整体正常</Badge><h2>项目仪表盘</h2><p>集中查看项目进度、部门负荷、关键里程碑和风险事项，并可直接进入对应工作区处理。</p></div>
        <div className={styles.projectMetric}><ProgressRing value={74} /><span>首演倒计时</span><b>24 天</b></div>
      </section>
      <section className={styles.projectDashboard} aria-label="项目关键指标">
        <button type="button" className={styles.dashboardProgressCard} onClick={() => go("milestones")}>
          <header><span>项目总体进度</span><em>查看里程碑 →</em></header>
          <div className={styles.dashboardValue}><b>74%</b><small>6 个里程碑中 3 个已完成，2 个正在推进</small></div>
          <div className={styles.dashboardStageBar} aria-label="已完成 50%，进行中 24%，待开始 26%"><i data-state="done" style={{ width: "50%" }} /><i data-state="active" style={{ width: "24%" }} /><i data-state="pending" style={{ width: "26%" }} /></div>
          <footer><span><i data-state="done" />已完成 3</span><span><i data-state="active" />进行中 2</span><span><i data-state="pending" />待开始 1</span></footer>
        </button>
        <button type="button" className={styles.dashboardHealthCard} onClick={() => go("tasks")}>
          <header><span>任务健康度</span><em>进入任务中心 →</em></header>
          <div className={styles.dashboardGauge}><span><b>18</b><small>/ 24</small></span></div>
          <div className={styles.dashboardHealthStats}><span><b>2</b><small>风险任务</small></span><span><b>4</b><small>本周到期</small></span><span><b>6</b><small>已完成</small></span></div>
        </button>
        <button type="button" className={styles.dashboardLoadCard} onClick={() => go("tasks")}>
          <header><span>部门任务负荷</span><em>7 个协作部门</em></header>
          <div className={styles.dashboardLoadBars}>
            {[["舞美制作", 92, "11"], ["舞台监督", 76, "8"], ["灯光", 64, "7"], ["音响", 48, "5"]].map(([label, value, count]) => <span key={label}><b>{label}</b><i><em style={{ width: `${value}%` }} /></i><strong>{count}</strong></span>)}
          </div>
          <small>舞美制作负荷接近上限，建议复核 7 月 24 日后的交付排期。</small>
        </button>
        <button type="button" className={styles.dashboardScheduleCard} onClick={() => go("notifications")}>
          <header><span>关键节点与待确认</span><em>8 人待确认</em></header>
          <div className={styles.dashboardScheduleList}>
            <span><time>20<small>7 月</small></time><b>第三幕合成排练</b><em data-tone="risk">待确认</em></span>
            <span><time>27<small>7 月</small></time><b>第一次全本联排</b><em>筹备中</em></span>
            <span><time>13<small>8 月</small></time><b>首演交付</b><em data-tone="done">里程碑</em></span>
          </div>
        </button>
      </section>
    </div>
  );
}

function ScriptWorkspace({ go }: { go: (v: View) => void }) {
  const [activeScene, setActiveScene] = useState("第三幕 · 海边重逢");
  const [rehearsalMode, setRehearsalMode] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  const [saved, setSaved] = useState(true);
  const scenes = [
    { chapter: "第一幕", name: "旧城来信", page: 1, state: "已确认" },
    { chapter: "第二幕", name: "潮汐之前", page: 18, state: "已确认" },
    { chapter: "第三幕", name: "海边重逢", page: 37, state: "编辑中" },
    { chapter: "第四幕", name: "告别与回声", page: 54, state: "待校对" },
  ];
  const lines = [
    { no: 116, speaker: "舞台提示", text: "（海浪声渐强。远处的灯塔亮起，罗密欧从观众席右侧通道进入。）", note: "LX 34 · SD 18" },
    { no: 117, speaker: "罗密欧", text: "我循着那束光走了很久，以为它会把我带回维罗纳。", note: "" },
    { no: 118, speaker: "朱丽叶", text: "可这里没有维罗纳，只有潮水记得我们曾经说过的话。", note: "重点台词" },
    { no: 119, speaker: "罗密欧", text: "那么，就让潮水替我们保守最后一个秘密。", note: "V 09" },
    { no: 120, speaker: "舞台提示", text: "（两人相隔三步。灯光从冷蓝缓慢过渡至日落色。）", note: "LX 38 · 5s" },
    { no: 121, speaker: "朱丽叶", text: "天亮之前，你还会离开吗？", note: "" },
  ];

  return (
    <div className={`${styles.contentStack} ${styles.productionWorkspace}`}>
      <section className={styles.productionToolbar}>
        <div className={styles.toolbarContext}>
          <span>工作版本</span>
          <select defaultValue="v12"><option value="v12">V12 · 联排版</option><option value="v11">V11 · 导演修订</option></select>
          <Badge tone="green">Editing</Badge>
        </div>
        <div className={styles.toolbarCenter}>
          <button type="button" aria-pressed={rehearsalMode} onClick={() => setRehearsalMode((value) => !value)}>
            <i className={rehearsalMode ? styles.toggleOn : ""}><span /></i>
            {rehearsalMode ? "排练模式" : "编辑模式"}
          </button>
          <span>{saved ? "✓ 已同步" : "正在保存…"}</span>
        </div>
        <div className={styles.toolbarActions}>
          <button type="button" onClick={() => setShowNotes((value) => !value)}>{showNotes ? "隐藏批注" : "显示批注"}</button>
          <button type="button">⌕ 搜索</button>
          <button type="button">显示 ⌄</button>
        </div>
      </section>

      <section className={`${styles.productionFrame} ${!showNotes ? styles.productionFrameNoNotes : ""}`}>
        <aside className={styles.scriptOutline}>
          <div className={styles.railHeading}><span>目录</span><button type="button">＋</button></div>
          <div className={styles.outlineProgress}><span><i /></span><small>剧本 74% 已确认</small></div>
          {scenes.map((scene) => (
            <button
              type="button"
              key={scene.name}
              className={activeScene.includes(scene.name) ? styles.outlineActive : ""}
              onClick={() => setActiveScene(`${scene.chapter} · ${scene.name}`)}
            >
              <small>{scene.chapter} · P.{scene.page}</small>
              <b>{scene.name}</b>
              <em>{scene.state}</em>
            </button>
          ))}
          <button type="button" className={styles.outlineLink} onClick={() => go("dramaturgy")}>打开构作视图 →</button>
        </aside>

        <article className={`${styles.scriptPaper} ${rehearsalMode ? styles.scriptPaperRehearsal : ""}`}>
          <header>
            <div><p>ACT III · SCENE 04</p><h2>{activeScene}</h2></div>
            <span>37 / 68 页</span>
          </header>
          <div className={styles.scriptSceneMeta}>
            <span>地点：海边平台</span><span>预计：12 min</span><span>人物：罗密欧、朱丽叶</span>
          </div>
          <div className={styles.scriptLines}>
            {lines.map((line) => (
              <button type="button" key={line.no} onClick={() => { setSaved(false); window.setTimeout(() => setSaved(true), 700); }}>
                <span>{line.no}</span>
                <strong>{line.speaker}</strong>
                <p>{line.text}</p>
                {line.note && <em>{line.note}</em>}
              </button>
            ))}
          </div>
          <footer><span>V12 · 自动保存</span><span>字数 326 · 约 3 分钟</span></footer>
        </article>

        {showNotes && (
          <aside className={styles.scriptInspector}>
            <div className={styles.railHeading}><span>协作与批注</span><button type="button">•••</button></div>
            <div className={styles.onlineEditors}><span>林</span><span>陈</span><span>王</span><small>3 人在线</small></div>
            <article><div><b>林淼</b><time>10:24</time></div><p>这里的进场路径已经与第三幕排练 Event 同步，注意从观众席右侧进入。</p><button type="button">回复</button></article>
            <article><div><b>陈洛华</b><time>昨天</time></div><p>第 118 行希望保留一次停顿，可否加排练记号？</p><button type="button">回复</button></article>
            <CollaborationCommentBox placeholder="评论当前段落，可输入 @姓名 提及成员" />
            <div className={styles.relatedObjects}>
              <span>关联对象</span>
              <button type="button" onClick={() => go("cue")}><b>8</b><small>Cue</small></button>
              <button type="button" onClick={() => go("events")}><b>2</b><small>Event</small></button>
              <button type="button" onClick={() => go("tasks")}><b>4</b><small>Task</small></button>
            </div>
          </aside>
        )}
      </section>
    </div>
  );
}

function DramaturgyWorkspace({ go }: { go: (v: View) => void }) {
  const [tab, setTab] = useState<"scenes" | "characters">("scenes");
  const [mode, setMode] = useState<"table" | "list">("table");
  const [selected, setSelected] = useState("s3");
  const scenes = [
    { id: "s1", no: "01", name: "旧城来信", synopsis: "一封迟到的信打破平静", action: "收到消息 → 决定离开", chars: "罗密欧 · 劳伦斯", duration: "14 min", mark: "稳定" },
    { id: "s2", no: "02", name: "潮汐之前", synopsis: "两条行动线在港口交汇", action: "寻找 → 错过 → 等待", chars: "朱丽叶 · 护士", duration: "18 min", mark: "待讨论" },
    { id: "s3", no: "03", name: "海边重逢", synopsis: "重逢后确认彼此的选择", action: "试探 → 坦白 → 约定", chars: "罗密欧 · 朱丽叶", duration: "12 min", mark: "本周重点" },
    { id: "s4", no: "04", name: "告别与回声", synopsis: "天亮前完成最后一次告别", action: "拖延 → 接受 → 离开", chars: "全体", duration: "16 min", mark: "待校对" },
  ];
  const characters = [
    { name: "罗密欧", scenes: 12, lines: 184, relation: "核心行动线", state: "陈洛华" },
    { name: "朱丽叶", scenes: 11, lines: 176, relation: "核心行动线", state: "周嘉" },
    { name: "劳伦斯", scenes: 5, lines: 62, relation: "信息推动者", state: "徐宁" },
    { name: "护士", scenes: 6, lines: 71, relation: "情感支点", state: "待定" },
  ];

  return (
    <div className={`${styles.contentStack} ${styles.productionWorkspace}`}>
      <section className={styles.productionToolbar}>
        <div className={styles.toolbarContext}><span>结构版本</span><select defaultValue="v12"><option value="v12">V12 · 联排版</option></select><Badge tone="blue">可编辑</Badge></div>
        <div className={styles.dramaturgyTabs}>
          <button type="button" aria-pressed={tab === "scenes"} onClick={() => setTab("scenes")}>章节</button>
          <button type="button" aria-pressed={tab === "characters"} onClick={() => setTab("characters")}>角色</button>
        </div>
        <div className={styles.toolbarActions}>
          {tab === "scenes" && <><button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>☰ 列表</button><button type="button" aria-pressed={mode === "table"} onClick={() => setMode("table")}>⊞ 表格</button></>}
          <button type="button">视图：构作总览 ⌄</button><button type="button">列设置</button>
        </div>
      </section>

      {tab === "scenes" ? (
        <section className={styles.dramaturgyFrame}>
          <div className={styles.structureSummary}>
            <div><strong>4</strong><span>章节</span><small>68 页</small></div>
            <div><strong>60</strong><span>预计分钟</span><small>较 V11 −4 min</small></div>
            <div><strong>8</strong><span>排练记号</span><small>3 个本周新增</small></div>
            <div><strong>2</strong><span>待处理</span><small>时长 / 角色确认</small></div>
          </div>
          {mode === "table" ? (
            <div className={styles.dramaturgyTableWrap}>
              <table className={styles.dramaturgyTable}>
                <thead><tr><th>章节</th><th>梗概</th><th>行动线</th><th>角色</th><th>预计时长</th><th>状态</th></tr></thead>
                <tbody>{scenes.map((scene) => <tr key={scene.id} className={selected === scene.id ? styles.tableRowSelected : ""} onClick={() => setSelected(scene.id)}><td><small>{scene.no}</small><b>{scene.name}</b></td><td>{scene.synopsis}</td><td>{scene.action}</td><td>{scene.chars}</td><td>{scene.duration}</td><td><Badge tone={scene.mark === "本周重点" ? "amber" : scene.mark === "稳定" ? "green" : "neutral"}>{scene.mark}</Badge></td></tr>)}</tbody>
              </table>
            </div>
          ) : (
            <div className={styles.dramaturgyCards}>{scenes.map((scene) => <button type="button" key={scene.id} onClick={() => setSelected(scene.id)} className={selected === scene.id ? styles.dramaturgyCardActive : ""}><span>{scene.no}</span><div><h3>{scene.name}</h3><p>{scene.synopsis}</p><small>{scene.action}</small></div><time>{scene.duration}</time></button>)}</div>
          )}
          <aside className={styles.structureInspector}>
            <div className={styles.railHeading}><span>章节详情</span><button type="button">编辑</button></div>
            {(() => { const scene = scenes.find((item) => item.id === selected) ?? scenes[2]; return <><h3>{scene.no} · {scene.name}</h3><label><span>梗概</span><textarea defaultValue={scene.synopsis} /></label><label><span>行动线</span><input defaultValue={scene.action} /></label><label><span>音乐 / 舞台提示</span><input defaultValue="海浪主题 · 灯塔亮起" /></label><CollaborationCommentBox placeholder="评论本章结构，可输入 @姓名 提及成员" /><button type="button" onClick={() => go("script")}>在剧本中定位 →</button></>; })()}
          </aside>
        </section>
      ) : (
        <section className={styles.characterMatrix}>
          <div className={styles.characterMatrixHeader}><div><p>CHARACTER MAP</p><h2>角色与行动线</h2></div><button type="button">＋ 新建角色</button></div>
          <div className={styles.characterRows}>{characters.map((character, index) => <article key={character.name}><span>{character.name.slice(0, 1)}</span><div><h3>{character.name}</h3><p>{character.relation}</p></div><dl><div><dt>出现章节</dt><dd>{character.scenes}</dd></div><div><dt>台词</dt><dd>{character.lines}</dd></div><div><dt>演员</dt><dd>{character.state}</dd></div></dl><i style={{ "--character-width": `${92 - index * 14}%` } as React.CSSProperties} /></article>)}</div>
        </section>
      )}
    </div>
  );
}

function CueWorkspace({ go, setDrawer }: { go: (v: View) => void; setDrawer: (v: "cue") => void }) {
  const [activeList, setActiveList] = useState("LX");
  const [visibleLists, setVisibleLists] = useState<string[]>(["LX", "SD", "V"]);
  const [selectedCue, setSelectedCue] = useState("LX 38");
  const cueLists = [
    { id: "LX", name: "灯光", count: 42, color: "teal" },
    { id: "SD", name: "音响", count: 23, color: "amber" },
    { id: "V", name: "多媒体", count: 12, color: "blue" },
    { id: "STG", name: "舞台", count: 18, color: "brown" },
  ];
  const cues = [
    { id: "LX 34", list: "LX", line: "116", title: "灯塔预亮", detail: "20% 冷白 · 3 秒", status: "已确认" },
    { id: "SD 18", list: "SD", line: "116", title: "海浪声渐强", detail: "-18dB → -8dB · 8 秒", status: "已确认" },
    { id: "V 09", list: "V", line: "119", title: "海面反光素材", detail: "循环播放 · 同步 LX 38", status: "待联调" },
    { id: "LX 38", list: "LX", line: "120", title: "冷蓝转日落色", detail: "5 秒淡变 · GO on action", status: "有风险" },
  ];
  const activeCue = cues.find((cue) => cue.id === selectedCue) ?? cues[3];

  function toggleVisible(id: string) {
    setVisibleLists((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  }

  return (
    <div className={`${styles.contentStack} ${styles.productionWorkspace}`}>
      <section className={styles.productionToolbar}>
        <div className={styles.cueListFilters}>{cueLists.map((list) => <button type="button" key={list.id} data-tone={list.color} aria-pressed={visibleLists.includes(list.id)} onClick={() => toggleVisible(list.id)}><b>{list.id}</b><span>{list.name}</span><small>{list.count}</small></button>)}</div>
        <div className={styles.cueActiveSelector}><span>激活表</span><select value={activeList} onChange={(event) => setActiveList(event.target.value)}>{cueLists.map((list) => <option key={list.id}>{list.id}</option>)}</select><Badge tone="green">可编辑</Badge></div>
        <div className={styles.toolbarActions}><button type="button">行</button><button type="button">页</button><button type="button">段落</button><button type="button">导出</button></div>
      </section>

      <section className={styles.cueFrame}>
        <aside className={styles.cueIndex}>
          <div className={styles.railHeading}><span>Cue 表</span><button type="button">＋</button></div>
          <div className={styles.cueIndexSummary}><b>{activeList}</b><span>{cueLists.find((item) => item.id === activeList)?.name}</span><small>{cues.filter((cue) => cue.list === activeList).length} 个当前段落 Cue</small></div>
          {cues.filter((cue) => visibleLists.includes(cue.list)).map((cue) => <button type="button" key={cue.id} className={selectedCue === cue.id ? styles.cueIndexActive : ""} onClick={() => setSelectedCue(cue.id)}><span>{cue.id}</span><div><b>{cue.title}</b><small>行 {cue.line} · {cue.status}</small></div></button>)}
          <button type="button" className={styles.outlineLink} onClick={() => go("planning")}>查看演出执行表 →</button>
        </aside>

        <article className={styles.cueScript}>
          <header><div><p>第三幕 · 海边重逢</p><h2>剧本锚点与部门 Cue</h2></div><span>滚动锁定</span></header>
          <div className={styles.cueScriptRows}>
            {[116,117,118,119,120,121].map((line) => {
              const lineCues = cues.filter((cue) => cue.line === String(line) && visibleLists.includes(cue.list));
              const text: Record<number,string> = {116:"（海浪声渐强。远处的灯塔亮起。）",117:"罗密欧　我循着那束光走了很久。",118:"朱丽叶　这里只有潮水记得我们。",119:"罗密欧　让潮水替我们保守最后一个秘密。",120:"（两人相隔三步。灯光缓慢过渡。）",121:"朱丽叶　天亮之前，你还会离开吗？"};
              return <div key={line} className={lineCues.length ? styles.cueScriptRowMarked : ""}><span>{line}</span><p>{text[line]}</p><div>{lineCues.map((cue) => <button type="button" key={cue.id} data-list={cue.list} className={selectedCue === cue.id ? styles.cueChipActive : ""} onClick={() => setSelectedCue(cue.id)}><b>{cue.id}</b><small>{cue.title}</small></button>)}</div></div>;
            })}
          </div>
          <button type="button" className={styles.insertCueButton}>＋ 在所选位置插入 {activeList} Cue</button>
        </article>

        <aside className={styles.cueInspector}>
          <div className={styles.railHeading}><span>Cue 详情</span><button type="button" onClick={() => setDrawer("cue")}>•••</button></div>
          <div className={styles.cueInspectorTitle}><Badge tone={activeCue.status === "有风险" ? "red" : "blue"}>{activeCue.status}</Badge><h3>{activeCue.id} · {activeCue.title}</h3><p>锚定行 {activeCue.line} · 第三幕 / 排练记号 C</p></div>
          <label><span>执行说明</span><textarea defaultValue={activeCue.detail} /></label>
          <label><span>触发方式</span><select defaultValue="action"><option value="action">GO on action</option><option value="line">GO on line</option><option value="time">按时间</option></select></label>
          <label><span>负责人</span><input defaultValue={activeCue.list === "LX" ? "王恺镔 · 灯光" : activeCue.list === "SD" ? "周嘉 · 音响" : "韩松 · 多媒体"} /></label>
          <div className={styles.cueComments}><span>评论 · 2</span><p><b>林淼</b> 淡变改为 5 秒，和视频尾帧对齐。</p><button type="button">打开讨论 →</button></div>
          <CollaborationCommentBox placeholder="评论该 Cue，可输入 @姓名 提及负责人" />
          <button type="button" className={styles.cueSaveButton}>保存 Cue</button>
        </aside>
      </section>
    </div>
  );
}

type FinanceFlow = "budget" | "reimbursement";
type FinanceApprovalRecord = { id: string; type: FinanceFlow; title: string; amount: number; applicant: string; status: "审批中" | "已通过" | "待补充"; approver: string; updatedAt: string };

function FinanceApprovalView() {
  const [flow, setFlow] = useState<FinanceFlow | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [records, setRecords] = useState<FinanceApprovalRecord[]>([
    { id: "FA-260718-03", type: "budget", title: "舞美制作二阶段预算", amount: 128000, applicant: "徐宁", status: "审批中", approver: "制作人 · 林淼", updatedAt: "今天 10:24" },
    { id: "FA-260716-08", type: "reimbursement", title: "卡司集训场地与交通报销", amount: 8640, applicant: "周嘉", status: "待补充", approver: "财务 · 赵敏", updatedAt: "昨天 18:40" },
    { id: "FA-260712-02", type: "budget", title: "首轮宣发物料立项", amount: 56000, applicant: "陈嘉", status: "已通过", approver: "已归档", updatedAt: "7 月 12 日" },
  ]);
  const [form, setForm] = useState({ project: "海边的罗密欧", phase: "2期 · 排演期", task: "", category: "", amount: "", unitPrice: "", quantity: "1", unit: "项", owner: "林淼", purchaseStatus: "待采购", budgetRef: "", payer: "", invoiceStatus: "待开票", note: "" });
  const calculatedBudget = Math.max(0, Number(form.unitPrice || 0) * Number(form.quantity || 0));
  const updateForm = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const openFlow = (next: FinanceFlow) => {
    setSubmitted("");
    setForm({ project: "海边的罗密欧", phase: "2期 · 排演期", task: "", category: "", amount: "", unitPrice: "", quantity: "1", unit: "项", owner: "林淼", purchaseStatus: "待采购", budgetRef: "", payer: "", invoiceStatus: "待开票", note: "" });
    setFlow(next);
  };
  const submit = () => {
    if (!flow) return;
    const amount = flow === "budget" ? calculatedBudget : Number(form.amount || 0);
    const title = flow === "budget" ? `${form.project} · ${form.category || "预算提报"}` : `${form.project} · ${form.category || "费用报销"}`;
    setRecords((current) => [{ id: `FA-${Date.now().toString().slice(-8)}`, type: flow, title, amount, applicant: "林淼", status: "审批中", approver: flow === "budget" ? "项目负责人 · 陈嘉" : "部门负责人 · 徐宁", updatedAt: "刚刚" }, ...current]);
    setSubmitted(`${flow === "budget" ? "立项与预算提报" : "报销单"}已提交，正在进入审批流。`);
    setFlow(null);
  };
  const canSubmit = Boolean(form.project && form.category && (flow === "budget" ? calculatedBudget > 0 : Number(form.amount) > 0));

  return <div className={styles.contentStack}>
    {submitted && <div className={styles.financeSuccess} role="status"><b>✓ 提交成功</b><span>{submitted}</span><button type="button" onClick={() => setSubmitted("")}>×</button></div>}
    <section className={styles.financeHero}>
      <div><p className={styles.kicker}>FINANCE APPROVAL CENTER</p><h2>财务审批流</h2><span>所有项目成员均可发起；系统根据申请类型自动匹配负责人、财务与制作人审批节点。</span></div>
      <div className={styles.financeHeroActions}><button type="button" className={styles.primaryButton} onClick={() => openFlow("budget")}>＋ 立项与预算提报</button><button type="button" className={styles.secondaryButton} onClick={() => openFlow("reimbursement")}>＋ 新建报销单</button></div>
    </section>

    <div className={styles.financeStats}><article><span>待我处理</span><b>3</b><small>2 条预算 · 1 条报销</small></article><article><span>本项目已批预算</span><b>¥ 684,000</b><small>执行率 63%</small></article><article><span>本月已报销</span><b>¥ 46,280</b><small>12 笔 · 2 笔审批中</small></article></div>

    <section className={styles.financeEntryGrid}>
      <button type="button" onClick={() => openFlow("budget")}><i>01</i><span><b>立项与预算提报</b><small>定义项目、阶段、任务与预算明细，自动计算预算总额并进入审批。</small><em>项目成员均可发起 →</em></span></button>
      <button type="button" onClick={() => openFlow("reimbursement")}><i>02</i><span><b>报销单</b><small>关联已批准预算，填写实付金额、垫付人、开票状态并上传凭证。</small><em>从预算到报销可追溯 →</em></span></button>
    </section>

    <section className={`${styles.panel} ${styles.financeApprovalPanel}`}>
      <div className={styles.panelHeading}><div><p className={styles.kicker}>APPROVALS</p><h2>最近申请</h2><small>审批状态与当前处理人实时同步。</small></div><div className={styles.financeFilters}><button type="button" aria-pressed="true">全部</button><button type="button">我发起的</button><button type="button">待我审批</button></div></div>
      <div className={styles.financeApprovalTable}><div className={styles.financeApprovalHead}><span>编号 / 类型</span><span>申请事项</span><span>金额</span><span>申请人</span><span>当前节点</span><span>状态</span></div>{records.map((record) => <button type="button" key={record.id}><span><b>{record.id}</b><small>{record.type === "budget" ? "立项预算" : "费用报销"}</small></span><span><b>{record.title}</b><small>{record.updatedAt}</small></span><strong>¥ {record.amount.toLocaleString("zh-CN")}</strong><span>{record.applicant}</span><span>{record.approver}</span><Badge tone={record.status === "已通过" ? "green" : record.status === "待补充" ? "amber" : "blue"}>{record.status}</Badge></button>)}</div>
    </section>

    {flow && <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setFlow(null)}><section className={`${styles.modal} ${styles.financeFormModal}`} role="dialog" aria-modal="true" aria-labelledby="finance-form-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><p className={styles.kicker}>{flow === "budget" ? "PROJECT & BUDGET" : "REIMBURSEMENT"}</p><h2 id="finance-form-title">{flow === "budget" ? "立项与预算提报" : "报销单"}</h2><span>{flow === "budget" ? "先建立预算依据，再进入采购与报销。" : "请关联已批准预算并上传订单、发票等凭证。"}</span></div><button type="button" aria-label="关闭财务表单" onClick={() => setFlow(null)}>×</button></header>
      <div className={styles.financeFormBody}><div className={styles.financeFormFields}>
        <label><span>项目名称 *</span><select value={form.project} onChange={(event) => updateForm("project", event.target.value)}><option>海边的罗密欧</option><option>鲁迅精选音乐会</option></select></label>
        <label><span>阶段 *</span><select value={form.phase} onChange={(event) => updateForm("phase", event.target.value)}><option>1期 · 启动筹备期</option><option>2期 · 排演期</option><option>3期 · 合成期</option><option>4期 · 正式演出</option></select></label>
        <label><span>关联主任务</span><select value={form.task} onChange={(event) => updateForm("task", event.target.value)}><option value="">请选择任务</option><option>舞美工作前期准备</option><option>卡司集训</option><option>合成排练</option></select></label>
        <label><span>费用类型 *</span><select value={form.category} onChange={(event) => updateForm("category", event.target.value)}><option value="">请选择费用类型</option><option>舞美制作</option><option>场地租赁</option><option>交通差旅</option><option>演员劳务</option><option>宣传物料</option></select></label>
        {flow === "budget" ? <><label><span>预算单价 *</span><input type="number" min="0" value={form.unitPrice} onChange={(event) => updateForm("unitPrice", event.target.value)} placeholder="请输入单价" /></label><div className={styles.financeInlineFields}><label><span>预算数量 *</span><input type="number" min="1" value={form.quantity} onChange={(event) => updateForm("quantity", event.target.value)} /></label><label><span>单位</span><select value={form.unit} onChange={(event) => updateForm("unit", event.target.value)}><option>项</option><option>套</option><option>人/天</option><option>场</option></select></label></div><div className={styles.financeCalculated}><span>预算总金额</span><b>¥ {calculatedBudget.toLocaleString("zh-CN")}</b><small>由预算单价 × 数量自动计算</small></div><label><span>采购负责人 *</span><select value={form.owner} onChange={(event) => updateForm("owner", event.target.value)}><option>林淼</option><option>徐宁</option><option>周嘉</option></select></label><label><span>采购状态</span><select value={form.purchaseStatus} onChange={(event) => updateForm("purchaseStatus", event.target.value)}><option>待采购</option><option>采购中</option><option>已完成</option></select></label></> : <><label><span>关联预算表 *</span><select value={form.budgetRef} onChange={(event) => updateForm("budgetRef", event.target.value)}><option value="">请选择已批准预算</option><option>舞美制作二阶段预算 · 剩余 ¥42,000</option><option>卡司集训预算 · 剩余 ¥12,800</option></select></label><label><span>实付金额 *</span><input type="number" min="0" value={form.amount} onChange={(event) => updateForm("amount", event.target.value)} placeholder="请输入实付金额" /></label><label><span>垫付人 *</span><select value={form.payer} onChange={(event) => updateForm("payer", event.target.value)}><option value="">请选择人员</option><option>林淼</option><option>徐宁</option><option>周嘉</option></select></label><label><span>开票状态 *</span><select value={form.invoiceStatus} onChange={(event) => updateForm("invoiceStatus", event.target.value)}><option>待开票</option><option>已开票</option><option>无需发票</option></select></label></>}
        <label className={styles.financeWideField}><span>备注</span><textarea rows={3} value={form.note} onChange={(event) => updateForm("note", event.target.value)} placeholder="补充预算依据、采购说明或报销原因" /></label><label className={`${styles.financeWideField} ${styles.financeUpload}`}><span>附件（报价单、订单截图、发票等）</span><input type="file" multiple /></label>
      </div><aside className={styles.financeApprovalRoute}><p className={styles.kicker}>APPROVAL ROUTE</p><h3>审批流程预览</h3>{(flow === "budget" ? ["提交人 · 林淼", "项目负责人 · 陈嘉", "财务复核 · 赵敏", "制作人批准 · 林淼"] : ["提交人 · 林淼", "部门负责人 · 徐宁", "财务复核 · 赵敏", "出纳付款 · 刘蕾"]).map((item, index) => <div key={item}><i>{index + 1}</i><span><b>{item}</b><small>{index === 0 ? "提交后自动完成" : "待审批"}</small></span></div>)}<p>审批人会根据项目、部门、金额和费用类型自动匹配。</p></aside></div>
      <footer><button type="button" className={styles.secondaryButton} onClick={() => setFlow(null)}>保存草稿</button><button type="button" className={styles.primaryButton} disabled={!canSubmit} onClick={submit}>提交审批</button></footer>
    </section></div>}
  </div>;
}

function ModuleView({ view, data, go, setDrawer }: {
  view: View;
  data: { description: string; bullets: string[]; links: { label: string; target: View }[] };
  go: (v: View) => void;
  setDrawer: (v: "task" | "cue" | "notification") => void;
}) {
  return (
    <div className={styles.contentStack}>
      <section className={styles.moduleIntro}>
        <div><Badge tone={VIEW_META[view].side === "script" ? "blue" : "amber"}>{VIEW_META[view].eyebrow}</Badge><h2>{data.description}</h2><p>此页用于说明模块定位与跨模块入口，不代表最终生产界面。</p></div>
        <div className={styles.moduleNumber}>{VIEW_META[view].label.slice(0, 2)}</div>
      </section>
      <div className={styles.moduleDemoGrid}>
        <section className={styles.panel}>
          <p className={styles.kicker}>核心能力</p><h2>该模块负责什么</h2>
          <ul className={styles.featureList}>{data.bullets.map((item, i) => <li key={item}><span>0{i + 1}</span>{item}</li>)}</ul>
        </section>
        <section className={styles.panel}>
          <p className={styles.kicker}>CONTEXTUAL LINKS</p><h2>无需返回首页</h2>
          <div className={styles.contextLinks}>{data.links.map((item) => <button type="button" key={item.label} onClick={() => go(item.target)}><span>{item.label}</span><b>直接打开 →</b></button>)}</div>
        </section>
      </div>
      <section className={styles.panel}>
        <div className={styles.panelHeading}><div><p className={styles.kicker}>示意内容</p><h2>最近工作与关联对象</h2></div></div>
        <div className={styles.mockRows}>
          <button type="button" onClick={() => view === "cue" ? setDrawer("cue") : view === "materials" || view === "finance" ? setDrawer("task") : undefined}><span className={styles.rowIndex}>01</span><span><b>第三幕 · 海边重逢</b><small>关联：罗密欧、朱丽叶 · 12 分钟 · 8 个 Cue</small></span><Badge tone="blue">最近更新</Badge></button>
          <button type="button" onClick={() => setDrawer("task")}><span className={styles.rowIndex}>02</span><span><b>终场设计与执行准备</b><small>关联：2 个 Event · 4 个 Task · 3 份资产</small></span><Badge tone="amber">进行中</Badge></button>
          <button type="button"><span className={styles.rowIndex}>03</span><span><b>版本 V12 · 联排版</b><small>昨天 22:18 由 林淼 更新</small></span><Badge>已同步</Badge></button>
        </div>
      </section>
    </div>
  );
}

function MilestonesView({ records, setRecords, openCreate }: {
  records: MilestoneRecord[];
  setRecords: React.Dispatch<React.SetStateAction<MilestoneRecord[]>>;
  openCreate: (date: string) => void;
}) {
  const [sheet, setSheet] = useState<"gantt" | "fields">("gantt");
  const [scale, setScale] = useState<GanttScale>("day");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const suppressBarClickRef = useRef(false);
  const dragRef = useRef<{
    id: string;
    mode: MilestoneDragMode;
    startX: number;
    startY: number;
    width: number;
    start: string;
    end: string;
    rowIndex: number;
    moved: boolean;
  } | null>(null);
  const phases = ["0期 · 全周期", "1期 · 启动筹备期", "2期 · 排演期", "3期 · 合成期", "4期 · 正式演出"];
  const departments = ["制作组", "导演组", "演员组", "舞监组", "舞美制作", "灯光", "音响", "多媒体"];
  const owners = ["林淼", "陈嘉", "王玥", "周嘉", "徐宁", "韩松"];
  const statuses: MilestoneStatus[] = ["未开始", "筹备中", "进行中", "有风险", "已完成"];
  const scaleConfig = useMemo(() => {
    const config = {
      day: { start: "2026-07-06", days: 42, title: "JUL — AUG · 2026", labels: Array.from({ length: 6 }, (_, index) => new Date(2026, 6, 6 + index * 7)) },
      month: { start: "2026-07-01", days: 184, title: "JUL — DEC · 2026", labels: Array.from({ length: 6 }, (_, index) => new Date(2026, 6 + index, 1)) },
      quarter: { start: "2026-07-01", days: 549, title: "Q3 2026 — Q4 2027", labels: Array.from({ length: 6 }, (_, index) => new Date(2026, 6 + index * 3, 1)) },
      year: { start: "2026-01-01", days: 365, title: "2026 年度", labels: Array.from({ length: 12 }, (_, index) => new Date(2026, index, 1)) },
    } satisfies Record<GanttScale, { start: string; days: number; title: string; labels: Date[] }>;
    return config[scale];
  }, [scale]);
  const axisStart = new Date(`${scaleConfig.start}T12:00:00`);
  const axisDays = scaleConfig.days;
  const axisLabels = scaleConfig.labels.map((date) => scale === "day" ? `${date.getMonth() + 1}/${date.getDate()}` : scale === "month" ? `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}` : scale === "quarter" ? `${date.getFullYear()} Q${Math.floor(date.getMonth() / 3) + 1}` : `${date.getMonth() + 1} 月`);
  const selectedRecord = records.find((record) => record.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('[data-dismiss-surface="milestone-detail-drawer"]')) setSelectedId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [selectedId]);
  const daysFromStart = (date: string) => Math.round((new Date(`${date}T12:00:00`).getTime() - axisStart.getTime()) / 86400000);
  const addDays = (date: string, amount: number) => {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + amount);
    return next.toISOString().slice(0, 10);
  };
  const update = <K extends keyof MilestoneRecord>(id: string, key: K, value: MilestoneRecord[K]) => setRecords((current) => current.map((record) => record.id === id ? { ...record, [key]: value } : record));
  const startDrag = (event: React.PointerEvent<HTMLElement>, record: MilestoneRecord, rowIndex: number, mode: MilestoneDragMode) => {
    const timeline = event.currentTarget.closest(`.${styles.milestoneTimeline}`) as HTMLElement | null;
    if (!timeline) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressBarClickRef.current = false;
    dragRef.current = { id: record.id, mode, startX: event.clientX, startY: event.clientY, width: timeline.getBoundingClientRect().width, start: record.start, end: record.end, rowIndex, moved: false };
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
      drag.moved = true;
      suppressBarClickRef.current = true;
    }
    const deltaDays = Math.round((event.clientX - drag.startX) / drag.width * axisDays);
    const rowDelta = drag.mode === "move" ? Math.round((event.clientY - drag.startY) / 70) : 0;
    setRecords((current) => {
      const next = current.map((record) => {
      if (record.id !== drag.id) return record;
      if (drag.mode === "move") return { ...record, start: addDays(drag.start, deltaDays), end: addDays(drag.end, deltaDays) };
      if (drag.mode === "resize-start") {
        const start = addDays(drag.start, deltaDays);
        return { ...record, start: start <= drag.end ? start : drag.end };
      }
      const end = addDays(drag.end, deltaDays);
      return { ...record, end: end >= drag.start ? end : drag.start };
      });
      if (rowDelta !== 0) {
        const fromIndex = next.findIndex((record) => record.id === drag.id);
        const targetIndex = Math.max(0, Math.min(next.length - 1, fromIndex + rowDelta));
        if (fromIndex >= 0 && targetIndex !== fromIndex) {
          const targetPhase = next[targetIndex].phase;
          const [moved] = next.splice(fromIndex, 1);
          next.splice(Math.max(0, Math.min(next.length, targetIndex)), 0, { ...moved, phase: targetPhase });
          drag.rowIndex = targetIndex;
          drag.startY += rowDelta * 70;
        }
      }
      return next;
    });
  };
  const finishDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag && (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3)) {
      suppressBarClickRef.current = true;
    }
    dragRef.current = null;
  };
  const addBlank = (openEditor: boolean) => {
    const id = `m-${Date.now()}`;
    setRecords((current) => [...current, { id, phase: "1期 · 启动筹备期", title: "待命名里程碑", childTasks: [], completedTasks: [], status: "未开始", start: "2026-07-20", end: "2026-07-22", owner: "林淼", department: "制作组", docs: "", details: "" }]);
    if (openEditor) {
      setSheet("gantt");
      setSelectedId(id);
    }
  };

  return <div className={styles.contentStack}>
    <div className={styles.sheetTabs} role="tablist" aria-label="里程碑视图">
      <button type="button" role="tab" aria-selected={sheet === "gantt"} onClick={() => setSheet("gantt")}><span>▤</span><b>时间轴</b><small>阶段周期与关键交付</small></button>
      <button type="button" role="tab" aria-selected={sheet === "fields"} onClick={() => setSheet("fields")}><span>▦</span><b>信息表</b><small>字段、负责人和任务明细</small></button>
      <button type="button" className={styles.sheetAddButton} onClick={() => addBlank(true)}>＋ 新建里程碑</button>
    </div>

    {sheet === "gantt" ? <section className={`${styles.panel} ${styles.milestonePanel}`}>
      <div className={styles.panelHeading}><div><p className={styles.kicker}>{scaleConfig.title}</p><h2>项目里程碑甘特图</h2><small>按阶段查看周期、进度与关键交付；手机端可横向滑动，并点按条目查看详情。</small></div><div className={styles.ganttHeadingActions}><div className={styles.ganttScale} aria-label="时间轴粒度">{([['day','日'],['month','月'],['quarter','季'],['year','年']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={scale === value} onClick={() => setScale(value)}>{label}</button>)}</div><div className={styles.legend}><span><i className={styles.legendEvent} />进行中</span><span><i className={styles.legendTask} />筹备中</span><span><i className={styles.legendRisk} />有风险</span></div></div></div>
      <div className={styles.milestoneMobileGantt}>
        <div className={styles.milestoneMobileGanttViewport}>
          <div className={styles.milestoneMobileGanttCanvas}>
            <div className={styles.milestoneMobileGanttHead}><span>阶段 / 里程碑</span><div style={{ gridTemplateColumns: `repeat(${axisLabels.length}, minmax(72px, 1fr))` }}>{axisLabels.map((label) => <b key={label}>{label}</b>)}</div></div>
            {records.map((record, index) => {
              const left = Math.max(0, Math.min(axisDays - 1, daysFromStart(record.start)));
              const right = Math.max(left + 1, Math.min(axisDays, daysFromStart(record.end) + 1));
              const duration = Math.max(1, Math.round((new Date(`${record.end}T12:00:00`).getTime() - new Date(`${record.start}T12:00:00`).getTime()) / 86400000) + 1);
              return <div className={styles.milestoneMobileGanttRow} key={record.id}>
                <button type="button" onClick={() => setSelectedId(record.id)}><small>{record.phase}</small><b>{record.title}</b><time>{record.start.slice(5).replace("-", "/")}—{record.end.slice(5).replace("-", "/")}</time></button>
                <div className={styles.milestoneMobileTimeline} style={{ backgroundSize: `${100 / axisLabels.length}% 100%` }}>
                  <button type="button" aria-label={`查看${record.title}详情`} className={`${styles.milestoneMobileBar} ${record.status === "有风险" ? styles.milestoneBarRisk : record.status === "已完成" ? styles.milestoneBarDone : index % 3 === 1 ? styles.milestoneBarMint : ""}`} style={{ left: `${left / axisDays * 100}%`, width: `${Math.max((right - left) / axisDays * 100, 7)}%` }} onClick={() => setSelectedId(record.id)}><span>{record.title}</span><em>{duration}天</em></button>
                  <strong style={{ left: `${right / axisDays * 100}%` }}>◆</strong>
                </div>
              </div>;
            })}
          </div>
        </div>
        <p>← 左右滑动查看完整周期 · 点击甘特条查看与编辑详情 →</p>
      </div>
      <div className={styles.milestoneGantt}>
        <div className={styles.milestoneGanttHead}><span>阶段 / 里程碑</span><div style={{ gridTemplateColumns: `repeat(${axisLabels.length}, minmax(0, 1fr))` }}>{axisLabels.map((label) => <b key={label}>{label}</b>)}</div></div>
        <div className={styles.milestoneCreateRail}><span>＋ 点击日期创建</span><div>{Array.from({ length: 48 }, (_, index) => { const iso = addDays(scaleConfig.start, Math.round(index / 48 * axisDays)); return <button key={`${iso}-${index}`} type="button" aria-label={`在 ${iso} 创建里程碑`} title={`${iso} · 新建里程碑`} onClick={() => openCreate(iso)} />; })}</div></div>
        {records.map((record, index) => {
          const left = Math.max(0, Math.min(axisDays - 1, daysFromStart(record.start)));
          const right = Math.max(left + 1, Math.min(axisDays, daysFromStart(record.end) + 1));
          const duration = Math.max(1, Math.round((new Date(`${record.end}T12:00:00`).getTime() - new Date(`${record.start}T12:00:00`).getTime()) / 86400000) + 1);
          const handleWidth = scale === "year" ? 6 : 12;
          return <div className={styles.milestoneGanttRow} key={record.id}>
            <button type="button" onClick={() => setSelectedId(record.id)}><small>{record.phase}</small><b>{record.title}</b></button>
            <div className={styles.milestoneTimeline} style={{ gridTemplateColumns: `repeat(${axisLabels.length}, minmax(0, 1fr))` }}>{axisLabels.map((label) => <i key={label} />)}<button type="button" title={`${record.title} · ${duration} 天`} aria-label={`${record.title}，${duration} 天，拖动调整日期或行`} className={`${styles.milestoneBar} ${selectedId === record.id ? styles.milestoneBarSelected : ""} ${record.status === "有风险" ? styles.milestoneBarRisk : record.status === "已完成" ? styles.milestoneBarDone : index % 3 === 1 ? styles.milestoneBarMint : ""}`} style={{ left: `${left / axisDays * 100}%`, width: `${(right - left) / axisDays * 100}%` }} onClick={() => { if (suppressBarClickRef.current) { suppressBarClickRef.current = false; return; } setSelectedId(record.id); }} onPointerDown={(event) => startDrag(event, record, index, "move")} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => { dragRef.current = null; suppressBarClickRef.current = false; }}><span className={styles.milestoneBarTitle}>{record.title}</span><em>{duration} 天</em></button><button type="button" className={`${styles.milestoneEdgeHandle} ${scale === "year" ? styles.milestoneEdgeHandleCompact : ""}`} aria-label={`调整${record.title}开始日期`} style={{ left: `${left / axisDays * 100}%` }} onPointerDown={(event) => startDrag(event, record, index, "resize-start")} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => { dragRef.current = null; suppressBarClickRef.current = false; }} /><button type="button" className={`${styles.milestoneEdgeHandle} ${scale === "year" ? styles.milestoneEdgeHandleCompact : ""}`} aria-label={`调整${record.title}结束日期`} style={{ left: `calc(${right / axisDays * 100}% - ${handleWidth}px)` }} onPointerDown={(event) => startDrag(event, record, index, "resize-end")} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => { dragRef.current = null; suppressBarClickRef.current = false; }} /><strong style={{ left: `${right / axisDays * 100}%` }}>◆</strong></div>
          </div>;
        })}
        <button type="button" className={styles.milestoneAddRecordRow} onClick={() => addBlank(true)}><span>＋</span><b>新增里程碑记录</b><small>先创建空白记录，再填写基础信息与起止日期；也可在时间轴上点击或拖拽调整。</small></button>
      </div>
    </section> : <section className={`${styles.panel} ${styles.milestoneFieldsPanel}`}>
      <div className={styles.panelHeading}><div><p className={styles.kicker}>MILESTONE RECORDS</p><h2>里程碑信息表</h2><small>集中维护阶段、日期、负责人和关联任务；修改后实时同步至甘特图。</small></div><button type="button" onClick={() => addBlank(false)}>＋ 新建记录</button></div>
      <div className={styles.milestoneMobileFields} role="table" aria-label="里程碑信息表">
        <div role="row"><b role="columnheader">#</b><b role="columnheader">阶段</b><b role="columnheader">操作</b></div>
        {records.map((record, index) => <div role="row" key={record.id}><span role="cell">{index + 1}</span><span role="cell"><b>{record.phase}</b></span><button type="button" role="cell" aria-label={`查看与编辑${record.title}详情`} onClick={() => setSelectedId(record.id)}>查看与编辑详情</button></div>)}
      </div>
      <div className={styles.milestoneTableWrap}><table className={styles.milestoneTable}><thead><tr><th>#</th><th>阶段⌄</th><th>主任务</th><th>状态⌄</th><th>预计开始</th><th>预计结束</th><th>负责人⌄</th><th>部门⌄</th><th>自动进度</th><th>关联任务 / 文档</th><th /></tr></thead><tbody>{records.map((record, index) => <tr key={record.id}><td>{index + 1}</td><td><select value={record.phase} onChange={(event) => update(record.id, "phase", event.target.value)}>{phases.map((phase) => <option key={phase}>{phase}</option>)}</select></td><td><input value={record.title} onChange={(event) => update(record.id, "title", event.target.value)} /></td><td><select className={styles.statusSelect} data-status={record.status} value={record.status} onChange={(event) => update(record.id, "status", event.target.value as MilestoneStatus)}>{statuses.map((status) => <option key={status}>{status}</option>)}</select></td><td><input type="date" value={record.start} onChange={(event) => update(record.id, "start", event.target.value)} /></td><td><input type="date" value={record.end} min={record.start} onChange={(event) => update(record.id, "end", event.target.value)} /></td><td><select value={record.owner} onChange={(event) => update(record.id, "owner", event.target.value)}>{owners.map((owner) => <option key={owner}>{owner}</option>)}</select></td><td><select value={record.department} onChange={(event) => update(record.id, "department", event.target.value)}>{departments.map((department) => <option key={department}>{department}</option>)}</select></td><td><div className={styles.progressAuto} aria-label={`${record.title}自动进度 ${getMilestoneProgress(record)}%`}><span><i style={{ width: `${getMilestoneProgress(record)}%` }} /></span><b>{getMilestoneProgress(record)}%</b><small>{record.completedTasks.length}/{record.childTasks.length} 项已完成</small></div></td><td><div className={styles.tableTags}>{record.childTasks.slice(0, 2).map((task) => <span key={task} data-complete={record.completedTasks.includes(task)}>{record.completedTasks.includes(task) ? "✓ " : ""}{task}</span>)}{record.docs && <span>{record.docs}</span>}<button type="button">＋</button></div></td><td><button type="button" aria-label={`删除${record.title}`} onClick={() => setRecords((current) => current.filter((item) => item.id !== record.id))}>×</button></td></tr>)}</tbody></table></div>
      <p className={styles.sheetSyncNote}>↔ 同一份数据：在这里直接填写会生成甘特条；从甘特新建则会自动补出这一行。</p>
    </section>}
    {selectedRecord && <aside className={styles.milestoneDetailDrawer} aria-label="里程碑详情编辑" data-dismiss-surface="milestone-detail-drawer">
      <div className={styles.milestoneDetailHeader}><div><p>MILESTONE DETAIL</p><h2>{selectedRecord.title}</h2></div><button type="button" onClick={() => setSelectedId(null)} aria-label="关闭里程碑详情">×</button></div>
      <div className={styles.milestoneDetailBody}><div className={styles.milestoneDetailStatus}><Badge tone={selectedRecord.status === "有风险" ? "red" : selectedRecord.status === "已完成" ? "green" : "blue"}>{selectedRecord.status}</Badge><span>修改内容会实时同步到甘特图与信息表</span></div>
        <label><span>里程碑名称</span><input value={selectedRecord.title} onChange={(event) => update(selectedRecord.id, "title", event.target.value)} /></label>
        <div className={styles.milestoneDetailGrid}><label><span>开始日期</span><input type="date" value={selectedRecord.start} onChange={(event) => update(selectedRecord.id, "start", event.target.value)} /></label><label><span>结束日期</span><input type="date" min={selectedRecord.start} value={selectedRecord.end} onChange={(event) => update(selectedRecord.id, "end", event.target.value)} /></label></div>
        <div className={styles.milestoneDetailGrid}><label><span>阶段</span><select value={selectedRecord.phase} onChange={(event) => update(selectedRecord.id, "phase", event.target.value)}>{phases.map((phase) => <option key={phase}>{phase}</option>)}</select></label><label><span>状态</span><select value={selectedRecord.status} onChange={(event) => update(selectedRecord.id, "status", event.target.value as MilestoneStatus)}>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label></div>
        <div className={styles.milestoneDetailGrid}><label><span>负责人</span><select value={selectedRecord.owner} onChange={(event) => update(selectedRecord.id, "owner", event.target.value)}>{owners.map((owner) => <option key={owner}>{owner}</option>)}</select></label><label><span>负责部门</span><select value={selectedRecord.department} onChange={(event) => update(selectedRecord.id, "department", event.target.value)}>{departments.map((department) => <option key={department}>{department}</option>)}</select></label></div>
        <div className={styles.milestoneAutoProgress}><span>自动进度 · {getMilestoneProgress(selectedRecord)}%</span><div><i style={{ width: `${getMilestoneProgress(selectedRecord)}%` }} /></div><small>由关联任务完成情况自动计算：{selectedRecord.completedTasks.length}/{selectedRecord.childTasks.length} 项已完成，不支持人工修改。</small></div>
        <label><span>说明</span><textarea rows={5} value={selectedRecord.details} onChange={(event) => update(selectedRecord.id, "details", event.target.value)} placeholder="补充交付标准、依赖与风险说明" /></label>
        <div className={styles.milestoneDetailTip}><b>操作提示</b><span>拖动中间区域移动日期或换行；拖动左右边缘调整周期。</span></div>
      </div>
    </aside>}
  </div>;
}

function EventsView({ published, openWizard, setDrawer, go }: { published: boolean; openWizard: () => void; setDrawer: (v: "event" | "task" | "cue") => void; go: (v: View) => void }) {
  return (
    <div className={styles.contentStack}>
      <section className={styles.flowExplainer}>
        <div><span className={styles.flowStep}>1</span><b>定义 Event</b><small>类型、时间、地点、人员</small></div><i>→</i>
        <div><span className={styles.flowStep}>2</span><b>确认模板 Task</b><small>负责人、截止、通知对象</small></div><i>→</i>
        <div><span className={styles.flowStep}>3</span><b>发布与追踪</b><small>站内通知、确认、执行</small></div>
      </section>
      {published && <section className={styles.successBanner}><span>✓</span><div><b>首演技术合成已发布</b><small>已创建 4 个 Task，并向 18 位相关成员生成站内 Notification。</small></div><button type="button" onClick={() => go("notifications")}>查看通知</button></section>}
      <section className={styles.panel}>
        <div className={styles.panelHeading}><div><p className={styles.kicker}>UPCOMING</p><h2>即将发生</h2></div><button type="button" onClick={openWizard}>使用模板创建 <span>→</span></button></div>
        <div className={styles.eventList}>
          <article><time><b>20</b><small>7 月</small></time><div><div><Badge tone="blue">排练</Badge><Badge tone="amber">需要确认</Badge></div><h3><button type="button" className={styles.titleButton} onClick={() => setDrawer("event")}>第三幕合成排练</button></h3><p>13:30–18:00 · 黑匣子 B · 18 人</p><div className={styles.inlineActions}><button type="button" onClick={() => setDrawer("event")}>Event 执行流程 <span>→</span></button><button type="button" onClick={() => setDrawer("task")}>6 个 Task <span>→</span></button><button type="button" onClick={() => setDrawer("cue")}>24 个 Cue <span>→</span></button></div></div><span className={styles.eventStatus}>8 人未确认</span></article>
          <article><time><b>22</b><small>7 月</small></time><div><div><Badge tone="neutral">围读</Badge></div><h3>全本节奏围读</h3><p>14:00–17:00 · 排练厅 2 · 全体演员</p><div className={styles.inlineActions}><button type="button" onClick={() => go("script")}>关联剧本 V12 <span>→</span></button><button type="button" onClick={() => setDrawer("task")}>3 个 Task <span>→</span></button></div></div><span className={styles.eventStatus}>草稿</span></article>
          <article><time><b>13</b><small>8 月</small></time><div><div><Badge tone="red">演出</Badge></div><h3>首演</h3><p>19:30–21:45 · 城市剧院 · 全体</p><div className={styles.inlineActions}><button type="button" onClick={() => setDrawer("event")}>演出执行表 <span>→</span></button><button type="button" onClick={() => go("people")}>人员与 Call <span>→</span></button></div></div><span className={styles.eventStatus}>筹备中</span></article>
        </div>
      </section>
    </div>
  );
}

function TasksView({ items, completed, completeTask, progress, setDrawer, go, openCreate }: {
  items: PlannerItem[];
  completed: string[];
  completeTask: (id: string) => void;
  progress: number;
  setDrawer: (v: "task") => void;
  go: (v: View) => void;
  openCreate: () => void;
}) {
  const [scope, setScope] = useState<"mine" | "all" | "event">("mine");
  const plannedTasks = items.filter((item) => item.type === "task");
  const tasks = [
    ...plannedTasks.map((item, index) => ({ id: item.id, name: item.title, owner: index % 2 ? "灯光组" : "我", due: `${Number(item.date.slice(5, 7))} 月 ${Number(item.date.slice(8))} 日`, relation: item.relation ?? item.meta, kind: index === 1 ? "技术需求" : "标准 Task" })),
    { id: "t2", name: "完成地胶采购", owner: "制作组", due: "7 月 21 日", relation: "独立 Task · 舞台可交付", kind: "标准 Task" },
    { id: "t3", name: "铺设并完成安全检查", owner: "舞台组", due: "7 月 25 日", relation: "第一次全本联排", kind: "标准 Task" },
    { id: "t4", name: "技术部门需求确认", owner: "灯光组", due: "7 月 18 日", relation: "第三幕合成排练", kind: "技术需求" },
  ];
  const visibleTasks = scope === "mine" ? tasks.filter((task) => task.owner === "我") : scope === "event" ? tasks.filter((task) => !task.relation.startsWith("独立")) : tasks;
  return <div className={styles.contentStack}>
    <section className={styles.taskSummary}>
      <div><span>6</span><p><b>待我处理</b><small>2 项今天截止</small></p></div><div><span>3</span><p><b>进行中</b><small>跨 2 个部门</small></p></div><div><span>1</span><p><b>已阻塞</b><small>等待外部交付</small></p></div><div><ProgressRing value={progress} /><p><b>本周完成度</b><small>按 Task 状态统计</small></p></div>
    </section>
    <section className={styles.panel}>
      <div className={styles.taskToolbar}><div className={styles.segmented}>{([['mine','我的 Task'],['all','全部'],['event','按 Event']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={scope === id} onClick={() => setScope(id)}>{label}</button>)}</div><div className={styles.taskToolbarActions}><button type="button" className={styles.secondaryButton} onClick={() => go("planning")}>在日历中查看</button><button type="button" className={styles.primaryButton} onClick={openCreate}>＋ 新建 Task</button></div></div>
      <div className={styles.taskTableHeader}><span>状态</span><span>任务</span><span>关系</span><span>负责人 / 截止</span></div>
      <div className={styles.taskRows}>{visibleTasks.map((task) => { const done = completed.includes(task.id); return <article key={task.id} className={done ? styles.taskDone : ""}><button type="button" className={styles.taskCheck} aria-label={`${done ? "恢复" : "完成"}${task.name}`} onClick={() => completeTask(task.id)}>{done ? "✓" : ""}</button><button type="button" className={styles.taskTitleCell} onClick={() => setDrawer("task")}><b>{task.name}</b><small>{task.kind}</small></button><button type="button" className={styles.taskRelation} onClick={() => task.relation.includes("排练") || task.relation.includes("联排") ? go("events") : go("planning")}><b>{task.relation}</b><small>{task.relation.startsWith("独立") ? "未绑定 Event" : "打开关联对象 →"}</small></button><span className={styles.taskOwner}><small>{task.owner}</small><b>{task.due}</b></span></article>; })}</div>
    </section>
    <section className={styles.relationNote}><span>原则</span><p><b>Task 可以独立存在，也可以关联 Event 或里程碑。</b><small>技术需求保留为 Task 类型，不再让所有任务都必须从 Event 中创建。</small></p></section>
  </div>;
}

function NotificationsView({ acknowledged, setAcknowledged, setDrawer, openCompose, sentNotification }: { acknowledged: boolean; setAcknowledged: (v: boolean) => void; setDrawer: (v: "notification") => void; openCompose: () => void; sentNotification: string }) {
  return (
    <div className={styles.contentStack}>
      <section className={styles.notificationActionBar}>
        <div><p className={styles.kicker}>NOTIFICATION CENTER</p><h2>项目通知与确认</h2><span>向指定成员发送更新，并追踪阅读、确认与处理状态。</span></div>
        <button type="button" className={styles.primaryButton} onClick={openCompose}>＋ 新建通知</button>
      </section>
      {sentNotification && <div className={styles.successBanner} role="status"><span>✓</span><div><b>发送成功</b><small>{sentNotification}</small></div></div>}
      <section className={styles.notificationSummary}>
        <div><span>3</span><p><b>未读</b><small>仅告知或需要查看</small></p></div>
        <div><span>{acknowledged ? "1" : "2"}</span><p><b>待确认 / 处理</b><small>关键变化与行动</small></p></div>
        <div><span>{acknowledged ? "3" : "8"}</span><p><b>团队未确认</b><small>制作侧可追踪</small></p></div>
      </section>
      <section className={styles.panel}>
        <div className={styles.notificationTabs}><button type="button" aria-pressed="true">全部</button><button type="button">待确认</button><button type="button">仅告知</button><button type="button">已处理</button></div>
        <div className={styles.notificationList}>
          <article className={styles.importantNotice}><div className={styles.noticeType}>!</div><div><div><Badge tone="amber">必须确认</Badge><small>10 分钟前</small></div><h3>第三幕排练时间已调整</h3><p>原定 14:00，现调整为 13:30；你的 Call Time 为 13:00，地点不变。</p><div className={styles.ackProgress}><span><i style={{ width: acknowledged ? "83%" : "56%" }} /></span><small>{acknowledged ? "15 / 18 人已确认" : "10 / 18 人已确认"}</small></div><div className={styles.inlineActions}>{!acknowledged && <button type="button" className={styles.primaryButton} onClick={() => setAcknowledged(true)}>我已知悉并确认</button>}<button type="button" onClick={() => setDrawer("notification")}>查看未确认名单</button></div></div></article>
          <article><div className={styles.noticeType}>✓</div><div><div><Badge tone="blue">Task 指派</Badge><small>1 小时前</small></div><h3>你被指派：确认第三幕转场动线</h3><p>截止今天 18:00，关联“第三幕合成排练”。</p><button type="button" onClick={() => setDrawer("notification")}>查看 Task →</button></div></article>
          <article><div className={styles.noticeType}>C</div><div><div><Badge>仅告知</Badge><small>昨天 22:18</small></div><h3>灯光组更新了 Cue LX 38</h3><p>淡出时长从 3 秒调整为 5 秒，已同步到演出 Timetable。</p><button type="button" onClick={() => setDrawer("notification")}>查看变化 →</button></div></article>
        </div>
      </section>
    </div>
  );
}

function NotificationComposerModal({ close, send }: { close: () => void; send: (title: string, recipients: string) => void }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [recipients, setRecipients] = useState("第三幕合成排练参与人 · 18 人");
  const [level, setLevel] = useState<"info" | "confirm" | "action">("info");
  const [inApp, setInApp] = useState(true);
  const [feishu, setFeishu] = useState(false);
  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={close}><section className={`${styles.modal} ${styles.notificationComposerModal}`} role="dialog" aria-modal="true" aria-labelledby="notification-compose-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className={styles.modalHeader}><div><p>CREATE NOTIFICATION</p><h2 id="notification-compose-title">新建项目通知</h2></div><button type="button" onClick={close} aria-label="关闭">×</button></div>
    <p className={styles.modalLead}>通知可独立发送，也可由里程碑、事件、任务或评论触发。需要反馈的事项建议使用“需要确认”或“需要处理”。</p>
    <div className={styles.notificationComposeForm}>
      <label><span>通知标题 *</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="清晰说明发生了什么变化" /></label>
      <label><span>发送对象 *</span><select value={recipients} onChange={(event) => setRecipients(event.target.value)}><option>第三幕合成排练参与人 · 18 人</option><option>全体项目成员 · 36 人</option><option>技术部门负责人 · 5 人</option><option>@提及成员 · 3 人</option></select></label>
      <fieldset><legend>通知类型</legend>{([['info','仅告知','无需回复，用于一般信息同步'],['confirm','需要确认','要求收件人明确确认已知悉'],['action','需要处理','关联具体任务并跟踪完成状态']] as const).map(([id, label, note]) => <label key={id}><input type="radio" name="notification-level" checked={level === id} onChange={() => setLevel(id)} /><span><b>{label}</b><small>{note}</small></span></label>)}</fieldset>
      <label className={styles.notificationMessageField}><span>通知内容 *</span><textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="补充时间、地点、变更原因与下一步行动" /></label>
      <div className={styles.deliveryOptions}><b>发送渠道</b><label><input type="checkbox" checked={inApp} onChange={(event) => setInApp(event.target.checked)} />站内通知</label><label><input type="checkbox" checked={feishu} onChange={(event) => setFeishu(event.target.checked)} />同步至飞书</label></div>
    </div>
    <div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={close}>取消</button><button type="button" className={styles.primaryButton} disabled={!title.trim() || !message.trim() || (!inApp && !feishu)} onClick={() => send(title.trim(), recipients)}>发送通知</button></div>
  </section></div>;
}

function PlanningViewPanel({ mode, setMode, setDrawer, items, openCreate }: { mode: PlanningView; setMode: (m: PlanningView) => void; setDrawer: (v: "event" | "task" | "milestone" | "cue") => void; items: PlannerItem[]; openCreate: (type: PlannerObjectType, date: string) => void }) {
  const [selectedEventId, setSelectedEventId] = useState("e-tech");
  const [personFilter, setPersonFilter] = useState("lin");
  const [taskStatus, setTaskStatus] = useState<Record<string, LinkedPlanTask["status"]>>({});
  const [filter, setFilter] = useState<"all" | PlannerObjectType>("all");
  const filteredItems = filter === "all" ? items : items.filter((item) => item.type === filter);

  function openRundown(eventId: string) {
    setSelectedEventId(eventId);
    setMode("timetable");
  }

  function toggleTask(taskId: string) {
    const base = LINKED_PLAN_TASKS.find((task) => task.id === taskId)?.status ?? "待开始";
    setTaskStatus((current) => ({ ...current, [taskId]: (current[taskId] ?? base) === "已完成" ? "进行中" : "已完成" }));
  }

  return (
    <div className={styles.contentStack}>
      <div className={styles.viewTabs}>
        <button type="button" aria-pressed={mode === "calendar"} onClick={() => setMode("calendar")}><b>项目日历</b><small>事件、任务与里程碑</small></button>
        <button type="button" aria-pressed={mode === "gantt"} onClick={() => setMode("gantt")}><b>阶段甘特</b><small>项目阶段与重要排期</small></button>
        <button type="button" aria-pressed={mode === "timetable"} onClick={() => setMode("timetable")}><b>执行日程</b><small>按日期查看、导入与编辑</small></button>
      </div>
      {mode !== "timetable" && <div className={styles.planningToolbar}><div className={styles.filterChips}>{([['all','全部'],['event','Event'],['task','Task'],['milestone','里程碑']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{id === "all" ? items.length : items.filter((item) => item.type === id).length}</span></button>)}</div><button type="button" className={styles.secondaryButton}>仅看与我相关</button></div>}
      {mode === "calendar" && <CalendarMock items={filteredItems} openRundown={openRundown} setDrawer={setDrawer} openCreate={openCreate} />}
      {mode === "gantt" && <GanttMock openRundown={openRundown} setDrawer={setDrawer} />}
      {mode === "timetable" && <TimetableMock selectedEventId={selectedEventId} setSelectedEventId={setSelectedEventId} personFilter={personFilter} setPersonFilter={setPersonFilter} taskStatus={taskStatus} toggleTask={toggleTask} setDrawer={setDrawer} />}
    </div>
  );
}

function CalendarMock({ items, openRundown, setDrawer, openCreate }: { items: PlannerItem[]; openRundown: (id: string) => void; setDrawer: (v: "event" | "task" | "milestone") => void; openCreate: (type: PlannerObjectType, date: string) => void }) {
  const days = Array.from({ length: 28 }, (_, i) => i + 7);
  const [selectedDate, setSelectedDate] = useState("2026-07-20");
  const openItem = (item: PlannerItem) => item.type === "event" ? openRundown(item.id === "event-run" ? "e-run" : "e-tech") : setDrawer(item.type);
  const selectedItems = items.filter((item) => item.date === selectedDate);
  const selectedDateLabel = `${Number(selectedDate.slice(5, 7))} 月 ${Number(selectedDate.slice(8))} 日`;
  return <section className={styles.panel}>
    <div className={styles.panelHeading}><div><p className={styles.kicker}>2026 年 7 月</p><h2>项目日历</h2><small>月历统一展示事件、任务与里程碑；选择日期后可查看当天完整安排。</small></div><div className={styles.legend}><span><i className={styles.legendEvent} />事件</span><span><i className={styles.legendTask} />任务</span><span><i className={styles.legendMilestone} />里程碑</span></div></div>
    <div className={styles.calendarDesktop}><div className={styles.calendarWeek}>{["一", "二", "三", "四", "五", "六", "日"].map((d) => <span key={d}>周{d}</span>)}</div><div className={styles.calendarGrid}>{days.map((rawDay) => { const day = rawDay > 31 ? rawDay - 31 : rawDay; const month = rawDay > 31 ? "08" : "07"; const date = `2026-${month}-${String(day).padStart(2, "0")}`; const dayItems = items.filter((item) => item.date === date); const createDay = () => openCreate("event", date); return <div key={rawDay} role="button" tabIndex={0} aria-label={`${date} 日历格，点击创建日程`} onClick={createDay} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); createDay(); } }} className={`${styles.calendarCell} ${rawDay === 20 ? styles.todayCell : ""}`}><div className={styles.calendarDayLabel}>{day}<span>新建</span></div>{dayItems.map((item) => <button type="button" key={item.id} className={item.type === "event" ? styles.mainEvent : item.type === "task" ? styles.taskEvent : styles.milestoneEvent} onClick={(event) => { event.stopPropagation(); openItem(item); }} title={`${item.title} · ${item.meta}`}>{item.type === "milestone" ? "◆ " : `${item.type === "event" ? "事件" : "任务"} · `}{item.title}</button>)}</div>; })}</div><p className={styles.calendarHint}>点击日期空白处创建日程；已有事项可直接打开。</p></div>
    <div className={styles.calendarMobileMonth}>
      <div className={styles.calendarMobileToolbar}><b>2026 年 7 月</b><button type="button" onClick={() => openCreate("event", selectedDate)}>＋ 新建</button></div>
      <div className={styles.calendarMobileWeek}>{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className={styles.calendarMobileGrid}>{days.map((rawDay) => { const day = rawDay > 31 ? rawDay - 31 : rawDay; const month = rawDay > 31 ? "08" : "07"; const date = `2026-${month}-${String(day).padStart(2, "0")}`; const dayItems = items.filter((item) => item.date === date); return <div key={rawDay} className={`${date === selectedDate ? styles.calendarMobileSelected : ""} ${rawDay > 31 ? styles.calendarMobileOutside : ""}`}><button type="button" onClick={() => setSelectedDate(date)} aria-label={`选择 ${date}`}>{day}</button><span>{dayItems.slice(0, 3).map((item) => <button type="button" key={item.id} data-type={item.type} title={item.title} aria-label={`${item.title}，${item.meta}`} onClick={() => { setSelectedDate(date); openItem(item); }}>{item.title}</button>)}</span></div>; })}</div>
      <section className={styles.calendarMobileDayPanel} aria-label={`${selectedDateLabel}安排`}><header><div><small>已选日期</small><b>{selectedDateLabel}</b></div><button type="button" onClick={() => openCreate("event", selectedDate)}>＋ 新建日程</button></header>{selectedItems.length ? selectedItems.map((item) => <button type="button" key={item.id} onClick={() => openItem(item)}><i data-type={item.type} /><span><b>{item.title}</b><small>{item.time ? `${item.time} · ` : ""}{item.meta}</small></span><em>›</em></button>) : <p>当天暂无安排。点击“新建日程”添加事件、任务或里程碑。</p>}</section>
    </div>
  </section>;
}

function AgendaMock({ items, setDrawer, openCreate }: { items: PlannerItem[]; setDrawer: (v: "event" | "task" | "milestone") => void; openCreate: (type: PlannerObjectType, date: string) => void }) {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
  return <section className={styles.panel}><div className={styles.panelHeading}><div><p className={styles.kicker}>AGENDA</p><h2>按时间顺序</h2></div><button type="button" onClick={() => openCreate("task", "2026-07-20")}>＋ 快速记录 Task</button></div><div className={styles.agendaList}>{sorted.map((item) => <button type="button" key={item.id} onClick={() => setDrawer(item.type)}><time><b>{item.date.slice(8)}</b><small>{item.date.slice(5, 7)} 月</small></time><span className={styles.agendaType} data-type={item.type}>{item.type === "event" ? "E" : item.type === "task" ? "T" : "◆"}</span><span><b>{item.title}</b><small>{item.time ? `${item.time} · ` : ""}{item.meta}</small></span><strong>{item.type === "event" ? "Event" : item.type === "task" ? "Task" : "里程碑"}</strong></button>)}</div></section>;
}

function GanttMock({ openRundown, setDrawer }: { openRundown: (id: string) => void; setDrawer: (v: "task") => void }) {
  const rows = [
    { name: "剧本与构作", left: 4, right: 29, tone: "normal", label: "第三稿锁定", eventId: "" },
    { name: "舞美制作", left: 14, right: 49, tone: "normal", label: "舞台可交付", eventId: "" },
    { name: "灯光 / 音响", left: 28, right: 65, tone: "watch", label: "技术系统完成", eventId: "" },
    { name: "地胶采购与铺设", left: 16, right: 39, tone: "risk", label: "供应延期", eventId: "" },
    { name: "排练与联排", left: 31, right: 78, tone: "normal", label: "合成 → 全本联排", eventId: "e-tech" },
    { name: "首演准备", left: 69, right: 97, tone: "watch", label: "首演交付", eventId: "e-premiere" },
  ];
  return <section className={styles.panel}><div className={styles.panelHeading}><div><p className={styles.kicker}>JUL — AUG</p><h2>Event 与 Milestone 甘特</h2></div><div className={styles.legend}><span><i className={styles.legendEvent} />正常</span><span><i className={styles.legendTask} />需关注</span><span><i className={styles.legendRisk} />有风险</span></div></div><div className={styles.gantt}><div className={styles.ganttHeader}><span>工作流</span>{["7/13", "7/20", "7/27", "8/3", "8/10"].map((d) => <b key={d}>{d}</b>)}</div>{rows.map((row) => <button type="button" key={row.name} className={styles.ganttRow} onClick={() => row.eventId ? openRundown(row.eventId) : setDrawer("task")}><span>{row.name}</span><i className={styles.ganttGrid}>{[1,2,3,4,5].map((n) => <em key={n} />)}<b className={`${styles.ganttBar} ${styles[`gantt_${row.tone}`]}`} style={{ left: `${row.left}%`, width: `${row.right - row.left}%` }}>{row.label}</b><strong className={styles.ganttMilestone} style={{ left: `${row.right}%` }}>◆</strong></i></button>)}</div></section>;
}

function minutesOf(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function durationText(start: string, end: string) {
  return `${minutesOf(end) - minutesOf(start)} min`;
}

function TimetableMock({
  selectedEventId, setSelectedEventId, personFilter, setPersonFilter, taskStatus, toggleTask, setDrawer,
}: {
  selectedEventId: string; setSelectedEventId: (id: string) => void;
  personFilter: string; setPersonFilter: (id: string) => void;
  taskStatus: Record<string, LinkedPlanTask["status"]>; toggleTask: (id: string) => void;
  setDrawer: (v: "task" | "cue") => void;
}) {
  const event = PLANNING_EVENTS.find((item) => item.id === selectedEventId) ?? PLANNING_EVENTS[0];
  const eventItems = RUNDOWN_ITEMS.filter((item) => item.eventId === event.id);
  const visibleItems = personFilter === "all" ? eventItems : eventItems.filter((item) => item.participantIds.includes(personFilter) || item.type === "break");
  const relevantTaskIds = Array.from(new Set(eventItems.flatMap((item) => item.taskIds)));
  const completedCount = relevantTaskIds.filter((id) => (taskStatus[id] ?? LINKED_PLAN_TASKS.find((task) => task.id === id)?.status) === "已完成").length;
  const startMinutes = minutesOf(event.start);
  const endMinutes = minutesOf(event.end);
  const slotMinutes = 15;
  const slots = Array.from({ length: Math.max(1, (endMinutes - startMinutes) / slotMinutes) }, (_, index) => startMinutes + index * slotMinutes);
  const personName = personFilter === "all" ? "全部成员" : PLANNING_PEOPLE.find((person) => person.id === personFilter)?.name ?? "林淼";
  const [editMode, setEditMode] = useState(false);
  const [importedTaskIds, setImportedTaskIds] = useState<string[]>([]);
  const pendingTasks = [
    { id: "pool-stage", title: "复核舞台右侧安全通道", meta: "舞监 / 场务 · 13:45 前" },
    { id: "pool-costume", title: "第三幕服装快速检查", meta: "服化 · 演员 Call 后" },
    { id: "pool-backup", title: "导入视频备份与字幕版", meta: "多媒体 · 待排时间" },
  ];

  function fmtMinutes(total: number) {
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  function taskFor(item: RundownItem) {
    return LINKED_PLAN_TASKS.find((task) => item.taskIds.includes(task.id));
  }

  function statusFor(task?: LinkedPlanTask) {
    return task ? taskStatus[task.id] ?? task.status : null;
  }

  function statusClass(status: LinkedPlanTask["status"] | null) {
    if (status === "已完成") return styles.runStatusDone;
    if (status === "有风险") return styles.runStatusRisk;
    if (status === "进行中") return styles.runStatusActive;
    return styles.runStatusPending;
  }

  function gridPlacements(item: RundownItem) {
    if (item.laneIds.includes("all")) return [{ start: 2, span: RUNDOWN_LANES.length }];
    const indexes = item.laneIds.map((id) => RUNDOWN_LANES.findIndex((lane) => lane.id === id)).filter((index) => index >= 0).sort((a, b) => a - b);
    if (!indexes.length) return [];
    const contiguous = indexes.every((value, index) => index === 0 || value === indexes[index - 1] + 1);
    return contiguous ? [{ start: indexes[0] + 2, span: indexes[indexes.length - 1] - indexes[0] + 1 }] : indexes.map((index) => ({ start: index + 2, span: 1 }));
  }

  return (
    <section className={`${styles.panel} ${styles.rundownPanel}`}>
      <div className={styles.timetableHeader}>
        <div><p className={styles.kicker}>{event.date} · {event.status}</p><h2>Rundown / 现场执行表</h2><small>{event.start}–{event.end} · {event.location} · 15 分钟自动粒度</small></div>
        <div><Badge tone={completedCount === relevantTaskIds.length ? "green" : "amber"}>{completedCount} / {relevantTaskIds.length} Task 完成</Badge><Badge>{event.milestone}</Badge><button type="button" className={editMode ? styles.rundownEditActive : styles.rundownEditButton} onClick={() => setEditMode((value) => !value)}>{editMode ? "完成编辑" : "导入 / 编辑"}</button></div>
      </div>
      <div className={styles.rundownControls}>
        <label><span>日期 / Event</span><select value={event.id} onChange={(e) => setSelectedEventId(e.target.value)}>{PLANNING_EVENTS.map((item) => <option value={item.id} key={item.id}>{item.date} · {item.title}</option>)}</select></label>
        <label><span>查看工作流</span><select value={personFilter} onChange={(e) => setPersonFilter(e.target.value)}><option value="all">全部成员</option>{PLANNING_PEOPLE.map((person) => <option value={person.id} key={person.id}>{person.name} · {person.department}</option>)}</select></label>
        <p><b>{personName}</b><small>可查看其当前工作、对接人和工作地点</small></p>
      </div>

      <div className={`${styles.rundownWorkbench} ${editMode ? styles.rundownWorkbenchEditing : ""}`}>
        <div className={styles.rundownMatrixWrap}>
          <div className={styles.rundownGrid} style={{ "--lane-count": RUNDOWN_LANES.length, "--slot-count": slots.length } as React.CSSProperties}>
          <div className={styles.rundownCorner}><b>时间</b><small>地点 / 时长</small></div>
          {RUNDOWN_LANES.map((lane, index) => <div key={lane.id} className={`${styles.rundownLaneHeader} ${styles[`lane_${lane.tone}`]}`} style={{ gridColumn: index + 2 }}><b>{lane.label}</b><small>{lane.owner}</small></div>)}
          {slots.map((minutes, index) => <div key={minutes} className={styles.rundownTime} style={{ gridRow: index + 2 }}><b>{fmtMinutes(minutes)}</b><small>{index % 2 === 0 ? "15 min" : ""}</small></div>)}
          {visibleItems.flatMap((item) => gridPlacements(item).map((placement, placementIndex) => {
            const linkedTask = taskFor(item);
            const status = statusFor(linkedTask);
            const rowStart = Math.max(2, Math.floor((minutesOf(item.start) - startMinutes) / slotMinutes) + 2);
            const rowSpan = Math.max(1, Math.ceil((minutesOf(item.end) - minutesOf(item.start)) / slotMinutes));
            return <article key={`${item.id}-${placementIndex}`} tabIndex={0} className={`${styles.rundownCell} ${styles[`rundown_${item.type}`]} ${status === "有风险" ? styles.rundownRisk : ""}`} style={{ gridColumn: `${placement.start} / span ${placement.span}`, gridRow: `${rowStart} / span ${rowSpan}` }} onClick={() => setDrawer(item.type === "task" && item.laneIds.includes("light") ? "cue" : "task")}>
              <div><b>{item.title}</b>{linkedTask && <span className={`${styles.runStatus} ${statusClass(status)}`}>{status}</span>}</div>
              <small>{item.location} · {durationText(item.start, item.end)}</small>
              <p>{item.participantIds.map((id) => PLANNING_PEOPLE.find((person) => person.id === id)?.name).filter(Boolean).join(" · ")}</p>
              {linkedTask && <button type="button" onClick={(e) => { e.stopPropagation(); toggleTask(linkedTask.id); }}>{status === "已完成" ? "✓ 已完成" : `○ ${linkedTask.due} 前`}</button>}
            </article>;
          }))}
          </div>
        </div>
        {editMode && <aside className={styles.rundownTaskPool} aria-label="待排任务池"><header><div><p>待排 Task</p><h3>导入到当日 Rundown</h3></div><Badge>{pendingTasks.length}</Badge></header><p className={styles.rundownPoolHint}>从项目任务中选择；加入后可拖到时间与工作列。</p><div>{pendingTasks.map((task) => { const imported = importedTaskIds.includes(task.id); return <button type="button" key={task.id} aria-pressed={imported} onClick={() => setImportedTaskIds((current) => imported ? current.filter((id) => id !== task.id) : [...current, task.id])}><i>⋮⋮</i><span><b>{task.title}</b><small>{task.meta}</small></span><em>{imported ? "已加入" : "＋ 加入"}</em></button>; })}</div><button type="button" className={styles.rundownImportButton}>＋ 从任务中心导入更多</button><footer><span>编辑权限</span><b>管理员 / Rundown 排期负责人</b></footer></aside>}
      </div>

      <div className={styles.rundownMobileList}>
        <p><b>{personName}的执行时间线</b><small>点击人员筛选可查看其他人的工作与位置</small></p>
        {visibleItems.map((item) => {
          const linkedTask = taskFor(item);
          const status = statusFor(linkedTask);
          return <article key={item.id} onClick={() => setDrawer("task")}><time>{item.start}<small>{item.end}</small></time><div><span><Badge tone={item.type === "call" ? "amber" : item.type === "run" ? "blue" : "neutral"}>{item.type.toUpperCase()}</Badge>{status && <b>{status}</b>}</span><h3>{item.title}</h3><p>{item.location} · {item.note}</p><small>{item.participantIds.map((id) => PLANNING_PEOPLE.find((person) => person.id === id)?.name).filter(Boolean).join(" · ")}</small></div>{linkedTask && <button type="button" onClick={(e) => { e.stopPropagation(); toggleTask(linkedTask.id); }}>{status === "已完成" ? "✓" : "○"}</button>}</article>;
        })}
      </div>
    </section>
  );
}

function FrameworkView({ go }: { go: (v: View) => void }) {
  return (
    <div className={styles.contentStack}>
      <section className={styles.frameworkIntro}><div><Badge tone="blue">交互示意，不是生产代码</Badge><h2>这套框架帮助团队先确认“内容在哪里、如何到达、对象怎样关联”。</h2><p>视觉品牌、完整权限、财务流程和数据库结构留到产品框架确认以后。</p></div><button type="button" className={styles.primaryButton} onClick={() => go("home")}>从角色首页开始体验</button></section>
      <div className={styles.frameworkGrid}>
        <section className={styles.panel}><p className={styles.kicker}>INFORMATION ARCHITECTURE</p><h2>产品层级</h2><div className={styles.tree}><div><b>平台账号</b><small>Email · 微信 · 飞书</small></div><i /><div><b>我的工作</b><small>今日 · Task · 通知</small></div><i /><div className={styles.treeSplit}><span><b>机构 A</b><small>项目 1 · 项目 2</small></span><span><b>机构 B</b><small>项目 3</small></span></div></div></section>
        <section className={styles.panel}><p className={styles.kicker}>DESIGN PRINCIPLES</p><h2>核心交互原则</h2><ol className={styles.principleList}><li><span>01</span><div><b>我的工作优先</b><small>登录先回答“今天我要做什么”。</small></div></li><li><span>02</span><div><b>两侧分组，不做信息孤岛</b><small>一个对象只有一份数据。</small></div></li><li><span>03</span><div><b>关键事项可确认</b><small>通知不等于用户已经收到。</small></div></li><li><span>04</span><div><b>手机响应，桌面编排</b><small>按使用场景分配复杂度。</small></div></li></ol></section>
      </div>
      <section className={styles.panel}><div className={styles.panelHeading}><div><p className={styles.kicker}>DEVELOPMENT PRIORITY</p><h2>开发优先级与可降级方案</h2></div></div><div className={styles.priorityTable}><div><Badge tone="red">P0</Badge><span><b>必须保留</b><small>统一导航、我的工作、Event–Task–Notification 闭环、手机确认操作</small></span><strong>首轮原型</strong></div><div><Badge tone="amber">P1</Badge><span><b>标准体验</b><small>角色化首页排序、Calendar / Gantt / Timetable、右侧上下文抽屉</small></span><strong>资源允许</strong></div><div><Badge tone="blue">P2</Badge><span><b>增强体验</b><small>个人快捷入口、自定义首页、外部渠道提醒与复杂自动化</small></span><strong>后续迭代</strong></div></div></section>
      <section className={styles.panel}><div className={styles.panelHeading}><div><p className={styles.kicker}>RESPONSIVE RULES</p><h2>桌面与手机不是简单缩放</h2></div></div><div className={styles.deviceRules}><div><span className={styles.desktopDiagram}>▰</span><b>桌面端</b><p>常驻分组导航、主工作区和右侧详情抽屉。用于编排、批量处理、Gantt 与复杂编辑。</p></div><div><span className={styles.mobileDiagram}>▯</span><b>手机端</b><p>固定“今日、项目、Task、通知”，项目内切换两侧。用于现场查看、确认和快速完成。</p></div></div></section>
    </div>
  );
}

function DetailDrawer({ type, close, acknowledged, setAcknowledged, completeTask, completed }: { type: "event" | "task" | "milestone" | "cue" | "notification"; close: () => void; acknowledged: boolean; setAcknowledged: (v: boolean) => void; completeTask: (id: string) => void; completed: string[] }) {
  const heading = type === "event" ? ["EVENT DETAIL", "第三幕合成排练"] : type === "task" ? ["TASK DETAIL", "确认第三幕转场动线"] : type === "milestone" ? ["MILESTONE", "舞台可交付"] : type === "cue" ? ["CUE DETAIL", "LX 38 · 海浪淡出"] : ["NOTIFICATION DETAIL", "第三幕排练时间调整"];
  return <aside className={styles.drawer} aria-label="关联详情" data-dismiss-surface="detail-drawer"><div className={styles.drawerHeader}><div><p>{heading[0]}</p><h2>{heading[1]}</h2></div><button type="button" onClick={close} aria-label="关闭详情">×</button></div>{type === "event" && <div className={styles.drawerBody}><div><Badge tone="blue">排练</Badge> <Badge tone="amber">8 人未确认</Badge></div><p>Event 是一次真实发生的集体活动；日历展示的是同一个对象，不会另外复制一条日程。</p><dl><div><dt>时间与地点</dt><dd>7 月 20 日 13:30–18:00 · 黑匣子 B</dd></div><div><dt>参与范围</dt><dd>全体演员、舞台、灯光、音响、多媒体</dd></div><div><dt>相关工作</dt><dd>6 个 Task · 24 个 Cue · 4 个执行流程项</dd></div></dl><div className={styles.drawerActions}><button type="button" className={styles.secondaryButton}>查看执行流程</button><button type="button" className={styles.primaryButton}>进入 Event</button></div></div>}{type === "task" && <div className={styles.drawerBody}><Badge tone="amber">今天 18:00 截止</Badge><p>确认第三幕结束后，从海边平台到终场站位的转场路径，并与灯光暗场时间保持一致。</p><dl><div><dt>负责人</dt><dd>林淼（舞监）</dd></div><div><dt>主要 Event（可选）</dt><dd>第三幕合成排练</dd></div><div><dt>所属里程碑</dt><dd>舞台可交付</dd></div><div><dt>计划 / 截止</dt><dd>今天 16:00–17:30 / 18:00</dd></div></dl><label className={styles.drawerCheck}><input type="checkbox" checked={completed.includes("drawer-task")} onChange={() => completeTask("drawer-task")} /><span><b>标记为完成</b><small>完成后通知协作部门</small></span></label></div>}{type === "milestone" && <div className={styles.drawerBody}><Badge tone="amber">7 月 25 日</Badge><p>里程碑表达项目必须达到的节点，不需要像 Event 一样设置地点和参与人。</p><dl><div><dt>负责人</dt><dd>制作人 · 陈嘉</dd></div><div><dt>关联 Event</dt><dd>第三幕合成排练、第一次全本联排</dd></div><div><dt>任务进度</dt><dd>7 / 10 已完成 · 1 项有风险</dd></div></dl><button type="button" className={styles.primaryButton}>查看节点计划</button></div>}{type === "cue" && <div className={styles.drawerBody}><div><Badge tone="blue">灯光 Cue</Badge> <Badge>已同步 Event 执行表</Badge></div><blockquote>“潮水已经退去，但盐还留在我们身上。”</blockquote><dl><div><dt>动作</dt><dd>海浪纹理从 45% 淡出至 0%</dd></div><div><dt>时长</dt><dd>5 秒（原 3 秒）</dd></div><div><dt>关联部门</dt><dd>灯光、多媒体、音响</dd></div></dl><button type="button" className={styles.secondaryButton}>在剧本中定位</button></div>}{type === "notification" && <div className={styles.drawerBody}><Badge tone="amber">必须确认</Badge><p>第三幕合成排练由 14:00 调整至 13:30。你的 Call Time 为 13:00，地点仍为黑匣子 B。</p><dl><div><dt>已确认</dt><dd>{acknowledged ? "15 / 18 人" : "10 / 18 人"}</dd></div><div><dt>未确认</dt><dd>{acknowledged ? "王屿、周嘉、韩松" : "王屿、周嘉、韩松等 8 人"}</dd></div><div><dt>最后提醒</dt><dd>10 分钟前 · 站内通知</dd></div></dl>{!acknowledged && <button type="button" className={styles.primaryButton} onClick={() => setAcknowledged(true)}>我已知悉并确认</button>}</div>}</aside>;
}

function EventWizard({ step, setStep, close, publish }: { step: number; setStep: (s: number) => void; close: () => void; publish: () => void }) {
  const [selected, setSelected] = useState(["场地与人员确认", "Call Sheet 生成", "技术部门需求确认", "排练后 Notes"]);
  const [sendNotification, setSendNotification] = useState(true);
  const templates = ["场地与人员确认", "Call Sheet 生成", "技术部门需求确认", "排练后 Notes"];
  return <div className={styles.modalBackdrop} role="presentation"><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="event-wizard-title"><div className={styles.modalHeader}><div><p>CREATE EVENT · STEP {step} / 3</p><h2 id="event-wizard-title">{step === 1 ? "定义事件" : step === 2 ? "确认系统建议的任务" : "发布与通知"}</h2></div><button type="button" onClick={close} aria-label="关闭">×</button></div><div className={styles.stepper}><i className={step >= 1 ? styles.stepActive : ""} /><i className={step >= 2 ? styles.stepActive : ""} /><i className={step >= 3 ? styles.stepActive : ""} /></div>{step === 1 && <div className={styles.formGrid}><label><span>事件类型</span><select defaultValue="rehearsal"><option value="rehearsal">排练</option><option>围读</option><option>演出</option><option>会议</option></select></label><label><span>标题</span><input defaultValue="首演技术合成" /></label><label><span>日期与时间</span><input defaultValue="2026-07-30 13:00–21:00" /></label><label><span>地点</span><input defaultValue="城市剧院 · 主舞台" /></label><label className={styles.fullField}><span>参与范围</span><input defaultValue="全体演员、舞台、灯光、音响、多媒体、服化" /></label></div>}{step === 2 && <div><p className={styles.modalLead}>系统根据“技术合成”模板建议以下任务。发布前请确认负责人、截止时间和通知对象。</p><div className={styles.templateTasks}>{templates.map((task, i) => <label key={task}><input type="checkbox" checked={selected.includes(task)} onChange={() => setSelected((prev) => prev.includes(task) ? prev.filter((x) => x !== task) : [...prev, task])} /><span><b>{task}</b><small>{["制作组 · 事件前 3 天", "舞监组 · 事件前 1 天", "各部门负责人 · 事件前 2 天", "舞监组 · 事件后 2 小时"][i]}</small></span><Badge>{i === 2 ? "技术需求" : "标准任务"}</Badge></label>)}</div></div>}{step === 3 && <div className={styles.publishSummary}><div><span>◇</span><p><b>1 个事件</b><small>首演技术合成</small></p></div><div><span>✓</span><p><b>{selected.length} 个任务</b><small>保留负责人和截止时间</small></p></div><div><span>◉</span><p><b>18 位成员</b><small>{sendNotification ? "将生成站内通知" : "本次不主动通知"}</small></p></div><label className={styles.linkedNotificationOption}><input type="checkbox" checked={sendNotification} onChange={(event) => setSendNotification(event.target.checked)} /><span><b>向参与人发送通知</b><small>时间与 Call 变更要求确认，普通任务更新仅告知。</small></span></label></div>}<div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={step === 1 ? close : () => setStep(step - 1)}>{step === 1 ? "取消" : "上一步"}</button><button type="button" className={styles.primaryButton} onClick={step === 3 ? publish : () => setStep(step + 1)}>{step === 3 ? "发布事件" : "继续"}</button></div></section></div>;
}

function MilestoneQuickModal({ initialDate, close, create }: { initialDate: string; close: () => void; create: (record: MilestoneRecord, notify: boolean) => void }) {
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState("2期 · 排演期");
  const [start, setStart] = useState(initialDate);
  const [end, setEnd] = useState(initialDate);
  const [owner, setOwner] = useState("林淼");
  const [department, setDepartment] = useState("制作组");
  const [status, setStatus] = useState<MilestoneStatus>("未开始");
  const [sendNotification, setSendNotification] = useState(true);
  function submit() {
    if (!title.trim() || !start || !end) return;
    create({ id: `m-${Date.now()}`, title: title.trim(), phase, start, end, owner, department, status, childTasks: [], completedTasks: [], docs: "", details: "信息待补充" }, sendNotification);
  }
  return <div className={styles.modalBackdrop} role="presentation"><section className={`${styles.modal} ${styles.milestoneCreateModal}`} role="dialog" aria-modal="true" aria-labelledby="milestone-create-title"><div className={styles.modalHeader}><div><p>{initialDate} · 里程碑时间轴</p><h2 id="milestone-create-title">新建里程碑</h2></div><button type="button" onClick={close} aria-label="关闭">×</button></div><p className={styles.modalLead}>先录入关键日期与负责人，系统会同步生成时间轴和信息表记录，后续可继续补充任务、文档与交付标准。</p><label className={styles.quickTitleField}><span>里程碑名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：一轮排练完成" /></label><div className={styles.formGrid}><label><span>阶段</span><select value={phase} onChange={(event) => setPhase(event.target.value)}><option>1期 · 启动筹备期</option><option>2期 · 排演期</option><option>3期 · 合成期</option><option>4期 · 正式演出</option><option>0期 · 全周期</option></select></label><label><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value as MilestoneStatus)}><option>未开始</option><option>筹备中</option><option>进行中</option><option>有风险</option><option>已完成</option></select></label><label><span>预计开始</span><input type="date" value={start} onChange={(event) => { setStart(event.target.value); if (end < event.target.value) setEnd(event.target.value); }} /></label><label><span>预计结束</span><input type="date" min={start} value={end} onChange={(event) => setEnd(event.target.value)} /></label><label><span>负责人</span><select value={owner} onChange={(event) => setOwner(event.target.value)}><option>林淼</option><option>陈嘉</option><option>王玥</option><option>周嘉</option><option>徐宁</option></select></label><label><span>负责部门</span><select value={department} onChange={(event) => setDepartment(event.target.value)}><option>制作组</option><option>导演组</option><option>演员组</option><option>舞监组</option><option>舞美制作</option><option>灯光</option><option>音响</option></select></label></div><label className={styles.linkedNotificationOption}><input type="checkbox" checked={sendNotification} onChange={(event) => setSendNotification(event.target.checked)} /><span><b>创建后通知负责人及协作成员</b><small>将包含里程碑名称、日期、阶段和负责人。</small></span></label><div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={close}>取消</button><button type="button" className={styles.primaryButton} disabled={!title.trim() || !start || !end} onClick={submit}>创建里程碑</button></div></section></div>;
}

function TemplateCenterModal({ close }: { close: () => void }) {
  const [selected, setSelected] = useState<"musical" | "short" | "blank">("musical");
  const [applied, setApplied] = useState(false);
  const [fields, setFields] = useState([
    { id: "phase", name: "阶段", type: "单选", options: "启动筹备期、排演期、合成期、正式演出" },
    { id: "status", name: "状态", type: "单选", options: "未开始、筹备中、进行中、有风险、已完成" },
    { id: "department", name: "负责部门", type: "多选", options: "制作、导演、演员、舞监、舞美、灯光、音响" },
    { id: "date", name: "预计起止时间", type: "日期区间", options: "同步日历与甘特" },
  ]);
  const templates = [
    { id: "musical" as const, icon: "♫", name: "音乐剧制作模板", note: "5 个阶段 · 18 个常用字段", tags: ["排演", "卡司", "合成", "演出"] },
    { id: "short" as const, icon: "▣", name: "短剧拍摄模板", note: "6 个阶段 · 21 个常用字段", tags: ["勘景", "通告", "拍摄", "后期"] },
    { id: "blank" as const, icon: "＋", name: "空白自定义模板", note: "从基础日期和负责人开始", tags: ["自由配置"] },
  ];
  return <div className={styles.modalBackdrop} role="presentation"><section className={`${styles.modal} ${styles.templateModal}`} role="dialog" aria-modal="true" aria-labelledby="template-center-title"><div className={styles.modalHeader}><div><p>PROJECT TEMPLATE & FIELD SCHEMA</p><h2 id="template-center-title">模板与字段配置</h2></div><button type="button" onClick={close} aria-label="关闭">×</button></div><p className={styles.modalLead}>模板会一次生成里程碑、节点与事件、任务和计划所需的字段与常用选项；应用后仍可按项目删减、增补。</p><div className={styles.templateCards}>{templates.map((template) => <button type="button" key={template.id} aria-pressed={selected === template.id} onClick={() => setSelected(template.id)}><i>{template.icon}</i><span><b>{template.name}</b><small>{template.note}</small><em>{template.tags.map((tag) => <span key={tag}>{tag}</span>)}</em></span></button>)}</div><div className={styles.templateWorkbench}><header><div><p>将生成的字段</p><h3>{templates.find((item) => item.id === selected)?.name}</h3></div><span>可继续编辑</span></header><div className={styles.templateModuleChips}><b>应用到</b><label><input type="checkbox" defaultChecked />里程碑</label><label><input type="checkbox" defaultChecked />节点与事件</label><label><input type="checkbox" defaultChecked />任务</label><label><input type="checkbox" defaultChecked />计划与日程</label></div><div className={styles.fieldSchemaList}>{fields.map((field, index) => <div key={field.id}><span>⋮⋮</span><input aria-label={`字段 ${index + 1} 名称`} value={field.name} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, name: event.target.value } : item))} /><select value={field.type} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, type: event.target.value } : item))}><option>单选</option><option>多选</option><option>日期区间</option><option>成员</option><option>文本</option><option>数字</option></select><input aria-label={`${field.name}选项`} value={field.options} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, options: event.target.value } : item))} /><button type="button" aria-label={`删除${field.name}`} onClick={() => setFields((current) => current.filter((item) => item.id !== field.id))}>×</button></div>)}</div><button type="button" className={styles.addSchemaField} onClick={() => setFields((current) => [...current, { id: `field-${Date.now()}`, name: "新字段", type: "单选", options: "选项 A、选项 B" }])}>＋ 添加字段</button></div>{applied && <div className={styles.successBanner}><span>✓</span><div><b>模板已应用到当前项目</b><small>示例字段和选项已生成，仍可继续调整。</small></div></div>}<div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={close}>稍后配置</button><button type="button" className={styles.primaryButton} onClick={() => setApplied(true)}>应用模板并继续配置</button></div></section></div>;
}

function PlannerCreateModal({ initialType, initialDate, close, create }: { initialType: PlannerObjectType; initialDate: string; close: () => void; create: (item: PlannerItem, notify: boolean) => void }) {
  const [type, setType] = useState<PlannerObjectType>(initialType);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(type === "event" ? "14:00–17:00" : "");
  const [relation, setRelation] = useState("");
  const [participants, setParticipants] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [sendNotification, setSendNotification] = useState(true);
  const labels = { event: "事件", task: "任务", milestone: "里程碑" };
  function submit() {
    if (!title.trim() || !date) return;
    const eventMeta = [location.trim() || "地点待定", participants.trim() || "参与人待定"].join(" · ");
    create({ id: `plan-${Date.now()}`, type, title: title.trim(), date, time: time || undefined, meta: type === "event" ? eventMeta : relation.trim() || (type === "task" ? "未关联事件" : "项目节点"), relation: description.trim() || relation.trim() || undefined }, sendNotification && Boolean(participants));
  }
  return <div className={styles.modalBackdrop} role="presentation"><section className={`${styles.modal} ${styles.quickCreateModal}`} role="dialog" aria-modal="true" aria-labelledby="planner-create-title"><div className={styles.modalHeader}><div><p>{date} · 项目日历</p><h2 id="planner-create-title">新建{labels[type]}</h2></div><button type="button" onClick={close} aria-label="关闭">×</button></div><label className={styles.quickTitleField}><span>主题</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`输入${labels[type]}名称`} /></label><div className={styles.objectTypePicker}>{(["event", "task", "milestone"] as const).map((itemType) => <button key={itemType} type="button" aria-pressed={type === itemType} onClick={() => { setType(itemType); setTime(itemType === "event" ? "14:00–17:00" : ""); setParticipants(""); }}>{itemType === "event" ? "◇" : itemType === "task" ? "✓" : "◆"}<span><b>{labels[itemType]}</b><small>{itemType === "event" ? "排练、会议或演出" : itemType === "task" ? "明确的执行事项" : "阶段性交付节点"}</small></span></button>)}</div><div className={styles.quickScheduleFields}><label><span>◷</span><b>日期</b><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>{type !== "milestone" && <label><span>时</span><b>{type === "event" ? "起止时间" : "计划时间"}</b><input value={time} onChange={(event) => setTime(event.target.value)} placeholder="14:00–17:00" /></label>}{type !== "milestone" && <label><span>人</span><b>{type === "event" ? "参与人 / 角色组" : "负责人 / 参与人"}</b><select value={participants} onChange={(event) => setParticipants(event.target.value)}><option value="">选择常用范围</option><option>全体演员</option><option>技术部门</option><option>主创团队</option><option>舞监与场务</option></select></label>}{type === "event" && <label><span>地</span><b>地点</b><select value={location} onChange={(event) => setLocation(event.target.value)}><option value="">选择常用场地</option><option>黑匣子 B</option><option>排练厅 A</option><option>城市剧院 · 主舞台</option><option>线上会议</option></select></label>}{type !== "event" && <label><span>链</span><b>{type === "task" ? "所属事件 / 里程碑" : "负责人 / 子里程碑"}</b><select value={relation} onChange={(event) => setRelation(event.target.value)}><option value="">可稍后补充</option><option>第三幕合成排练</option><option>第一次全本联排</option><option>舞台可交付</option><option>首演交付</option></select></label>}<label><span>记</span><b>描述</b><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="添加描述、准备事项或备注" rows={2} /></label></div>{participants && <label className={styles.linkedNotificationOption}><input type="checkbox" checked={sendNotification} onChange={(event) => setSendNotification(event.target.checked)} /><span><b>保存后通知相关人员</b><small>通知将包含时间、关联对象与工作说明。</small></span></label>}<div className={styles.modalFooter}><button type="button" className={styles.quickMoreButton}>更多选项</button><button type="button" className={styles.secondaryButton} onClick={close}>取消</button><button type="button" className={styles.primaryButton} disabled={!title.trim() || !date} onClick={submit}>保存{labels[type]}</button></div></section></div>;
}
