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
  | "events"
  | "tasks"
  | "notifications"
  | "planning"
  | "finance"
  | "materials"
  | "framework";

type Role = "制作人 / 舞监" | "导演 / 构作" | "设计 / 技术" | "演员";
type PlanningView = "calendar" | "gantt" | "timetable";
type AccountPage = "profile" | "security" | "preferences" | "privacy" | "help";
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

const VIEW_META: Record<View, { label: string; eyebrow: string; side?: "script" | "stage" }> = {
  home: { label: "我的工作", eyebrow: "平台级" },
  project: { label: "项目首页", eyebrow: "《海边的罗密欧》" },
  script: { label: "剧本", eyebrow: "剧本侧", side: "script" },
  dramaturgy: { label: "构作", eyebrow: "剧本侧", side: "script" },
  table: { label: "表格", eyebrow: "剧本侧", side: "script" },
  assets: { label: "数字资产", eyebrow: "剧本侧", side: "script" },
  cue: { label: "Cue", eyebrow: "剧本侧", side: "script" },
  people: { label: "人员与角色", eyebrow: "舞台侧", side: "stage" },
  events: { label: "Event", eyebrow: "舞台侧", side: "stage" },
  tasks: { label: "Task", eyebrow: "舞台侧", side: "stage" },
  notifications: { label: "Notification", eyebrow: "舞台侧", side: "stage" },
  planning: { label: "计划与日程", eyebrow: "舞台侧", side: "stage" },
  finance: { label: "财务", eyebrow: "舞台侧", side: "stage" },
  materials: { label: "实体物料", eyebrow: "舞台侧", side: "stage" },
  framework: { label: "产品框架说明", eyebrow: "交付给产品 / 设计 / 开发" },
};

const SCRIPT_NAV: { id: View; label: string; hint: string }[] = [
  { id: "script", label: "剧本", hint: "阅读 · 编辑 · 讨论" },
  { id: "dramaturgy", label: "构作", hint: "章节 · 行动线 · 舞台呈现" },
  { id: "table", label: "表格", hint: "场次 · 角色 · 时长" },
  { id: "assets", label: "数字资产", hint: "文件 · 图纸 · 音视频" },
  { id: "cue", label: "Cue", hint: "部门执行设计" },
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
  { id: "main", label: "主流程", owner: "林淼 · 舞监", tone: "main" },
  { id: "stage", label: "舞监 / 场务", owner: "林淼 · 徐宁", tone: "stage" },
  { id: "cast", label: "演员工作", owner: "陈洛华", tone: "stage" },
  { id: "light", label: "灯光", owner: "王恺镔", tone: "script" },
  { id: "audio", label: "音响", owner: "周嘉", tone: "script" },
  { id: "media", label: "多媒体", owner: "韩松", tone: "script" },
  { id: "props", label: "置景 / 道具", owner: "徐宁", tone: "stage" },
];

const RUNDOWN_ITEMS: RundownItem[] = [
  { id: "r-call", eventId: "e-tech", title: "全体 Call · 签到与设备预热", start: "13:00", end: "13:30", location: "黑匣子 B", laneIds: ["all"], participantIds: ["lin", "chen", "wang", "zhou", "han", "xu"], type: "call", taskIds: ["t-checkin"], note: "工作人员提前 30 分钟抵达；演员完成换装。" },
  { id: "r-stage", eventId: "e-tech", title: "第三幕走位与转场", start: "13:30", end: "14:30", location: "主舞台", laneIds: ["main", "stage", "cast"], participantIds: ["lin", "chen", "xu"], type: "run", taskIds: ["t-route", "t-props"], note: "从海边平台到终场站位，确认右侧通道。" },
  { id: "r-light", eventId: "e-tech", title: "LX 34–42 编程与联调", start: "13:30", end: "14:30", location: "灯光控制台", laneIds: ["light"], participantIds: ["wang", "lin"], type: "task", taskIds: ["t-light"], note: "LX 38 淡出调整为 5 秒。" },
  { id: "r-audio", eventId: "e-tech", title: "SD 18–23 音量平衡", start: "13:30", end: "14:15", location: "音响控制台", laneIds: ["audio"], participantIds: ["zhou", "lin"], type: "task", taskIds: ["t-audio"], note: "确认海浪声与对白清晰度。" },
  { id: "r-media", eventId: "e-tech", title: "V 09–12 海浪素材同步", start: "13:45", end: "14:30", location: "多媒体席", laneIds: ["media"], participantIds: ["han", "lin"], type: "task", taskIds: ["t-media"], note: "视频淡出需与 LX 38 同步。" },
  { id: "r-props", eventId: "e-tech", title: "平台与红色马克笔就位", start: "13:30", end: "14:00", location: "舞台右侧", laneIds: ["props"], participantIds: ["xu"], type: "task", taskIds: ["t-props"], note: "转场前复核道具清单。" },
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
  events: "E",
  tasks: "T",
  notifications: "通",
  planning: "计",
  finance: "¥",
  materials: "物",
  framework: "i",
};

const STAGE_NAV: { id: View; label: string; hint: string }[] = [
  { id: "events", label: "Event", hint: "围读 · 排练 · 演出" },
  { id: "tasks", label: "Task", hint: "任务 · 节点 · 里程碑" },
  { id: "notifications", label: "Notification", hint: "告知 · 确认 · 处理" },
  { id: "planning", label: "计划与日程", hint: "日历 · 甘特 · 执行表" },
  { id: "finance", label: "财务", hint: "预算 · 支出 · 关联" },
  { id: "materials", label: "实体物料", hint: "道具 · 服装 · 设备" },
];

const roleHome: Record<Role, { focus: string; secondary: string; note: string }> = {
  "制作人 / 舞监": {
    focus: "项目风险与未确认事项",
    secondary: "Event、Task、Gantt",
    note: "默认把跨部门风险、延期节点与未确认人员放在首页前部。",
  },
  "导演 / 构作": {
    focus: "剧本与排练内容",
    secondary: "构作、场次、评论",
    note: "默认突出最近剧本改动、章节时长和下一场排练的内容范围。",
  },
  "设计 / 技术": {
    focus: "部门 Cue 与交付",
    secondary: "Task、资产、物料",
    note: "默认突出本部门待执行 Cue、技术需求与文件更新。",
  },
  演员: {
    focus: "今天与我有关的事项",
    secondary: "Call、本人场次、确认",
    note: "默认隐藏管理噪声，首先显示到场时间、地点和必须确认的变化。",
  },
};

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
    description: "角色、演员、部门和职责的统一主入口；其他模块只引用，不复制。",
    bullets: ["角色与演员绑定", "部门、岗位与权限", "个人 Call、Task 和通知聚合"],
    links: [{ label: "查看角色场次", target: "table" }, { label: "查看本人日程", target: "planning" }],
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

export default function PrototypeClient() {
  const [view, setView] = useState<View>("home");
  const role: Role = "制作人 / 舞监";
  const [currentProject, setCurrentProject] = useState<ProjectOption>(PROJECTS[0]);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [mobileSide, setMobileSide] = useState<"script" | "stage">("script");
  const [drawer, setDrawer] = useState<"task" | "cue" | "notification" | null>(null);
  const [planningView, setPlanningView] = useState<PlanningView>("calendar");
  const [eventWizard, setEventWizard] = useState(false);
  const [eventStep, setEventStep] = useState(1);
  const [published, setPublished] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [completedTasks, setCompletedTasks] = useState<string[]>(["t1"]);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountPage, setAccountPage] = useState<AccountPage | null>(null);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [joinProjectOpen, setJoinProjectOpen] = useState(false);
  const [projectAvatarUrl, setProjectAvatarUrl] = useState<string | null>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const mobileRailRef = useRef<HTMLDivElement>(null);

  const meta = VIEW_META[view];
  const navForMobile = mobileSide === "script" ? SCRIPT_NAV : STAGE_NAV;
  const roleInfo = roleHome[role];
  const contentClass = `${styles.shell} ${mobilePreview ? styles.previewMobile : ""}`;

  useEffect(() => {
    const requestedView = new URLSearchParams(window.location.search).get("view");
    if (requestedView && requestedView in VIEW_META) setView(requestedView as View);
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

  const taskProgress = useMemo(() => Math.round((completedTasks.length / 4) * 100), [completedTasks]);

  return (
    <main className={styles.prototypeRoot}>
      <div className={styles.demoBar}>
        <span><strong>Click-In 2.0</strong> · UI/UX 产品框架演示</span>
        <span className={styles.demoHint}>模拟数据 · 不连接现有业务</span>
        <button type="button" onClick={() => setMobilePreview((v) => !v)} className={styles.demoButton}>
          {mobilePreview ? "返回桌面预览" : "切换手机预览"}
        </button>
      </div>

      {accountPage ? (
        <AccountCenter page={accountPage} setPage={setAccountPage} close={() => setAccountPage(null)} />
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
              CLICK-IN
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
                  <button type="button" className={styles.deferredAdminButton} onClick={() => setAccountMenuOpen(false)} title="后台管理将在下一轮深化">
                    <span>后台管理<small>下一轮</small></span><span>›</span>
                  </button>
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

        <aside className={styles.sidebar}>
          <nav aria-label="产品导航">
            <button type="button" className={`${styles.navItem} ${view === "home" ? styles.activeNav : ""}`} onClick={() => go("home")}>
              <span className={styles.navSymbol}>{NAV_GLYPHS.home}</span><span><b>我的工作</b><small>今天与我有关</small></span>
            </button>
            <button type="button" className={`${styles.navItem} ${view === "project" ? styles.activeNav : ""}`} onClick={() => go("project")}>
              <span className={styles.navSymbol}>{NAV_GLYPHS.project}</span><span><b>{currentProject.name}</b><small>进度与风险</small></span>
            </button>

            <div className={`${styles.navGroup} ${styles.scriptGroup}`}>
              <div className={styles.navGroupTitle}><span className={styles.scriptDot} />剧本侧</div>
              {SCRIPT_NAV.map((item) => (
                <button key={item.id} type="button" className={`${styles.navItem} ${view === item.id ? styles.activeNav : ""}`} onClick={() => go(item.id)}>
                  <span className={`${styles.navSymbol} ${styles.scriptSymbol}`}>{NAV_GLYPHS[item.id]}</span><span><b>{item.label}</b><small>{item.hint}</small></span>
                </button>
              ))}
            </div>

            <div className={`${styles.navGroup} ${styles.stageGroup}`}>
              <div className={styles.navGroupTitle}><span className={styles.stageDot} />舞台侧</div>
              {STAGE_NAV.map((item) => (
                <button key={item.id} type="button" className={`${styles.navItem} ${view === item.id ? styles.activeNav : ""}`} onClick={() => go(item.id)}>
                  <span className={`${styles.navSymbol} ${styles.stageSymbol}`}>{NAV_GLYPHS[item.id]}</span><span><b>{item.label}</b><small>{item.hint}</small></span>
                  {item.id === "notifications" && <em>3</em>}
                </button>
              ))}
            </div>
          </nav>
          <button type="button" className={`${styles.frameworkButton} ${view === "framework" ? styles.activeNav : ""}`} onClick={() => go("framework")}>
            <span>ⓘ</span><span><b>产品框架说明</b><small>交互规则与优先级</small></span>
          </button>
        </aside>

        <section className={styles.mobileProjectNav}>
          <div className={styles.segmented}>
            <button type="button" aria-pressed={mobileSide === "script"} onClick={() => setMobileSide("script")}>剧本侧</button>
            <button type="button" aria-pressed={mobileSide === "stage"} onClick={() => setMobileSide("stage")}>舞台侧</button>
          </div>
          <div className={styles.mobileRailShell}>
            <button type="button" className={styles.railArrow} onClick={() => moveMobileRail(-1)} aria-label="向左查看更多模块">‹</button>
            <div className={styles.mobileModuleRail} ref={mobileRailRef}>
              {navForMobile.map((item) => (
                <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => go(item.id)}>{item.label}</button>
              ))}
            </div>
            <button type="button" className={styles.railArrow} onClick={() => moveMobileRail(1)} aria-label="向右查看更多模块">›</button>
          </div>
        </section>

        <section className={styles.workspace}>
          <div className={styles.pageHeader}>
            <div>
              {view !== "project" && <p className={styles.eyebrow}>{view === "home" ? "2026 年 7 月 20 日 · 周一" : meta.eyebrow}</p>}
              <h1>{view === "project" ? currentProject.name : meta.label}</h1>
            </div>
            <div className={styles.headerActions}>
              {view === "home" && (
                <div className={styles.homeHeaderMeta} aria-label="今日项目概况">
                  <span><b>联排期</b><small>项目阶段</small></span>
                  <span><b>24 天</b><small>距首演</small></span>
                  <span><b>18 人</b><small>今日协作</small></span>
                </div>
              )}
              {view === "events" && <button type="button" className={styles.primaryButton} onClick={() => { setEventWizard(true); setEventStep(1); }}>＋ 创建 Event</button>}
              {view === "tasks" && <button type="button" className={styles.primaryButton} onClick={() => setDrawer("task")}>＋ 新建 Task</button>}
              {view !== "framework" && view !== "home" && <button type="button" className={styles.secondaryButton} onClick={() => go("framework")}>查看设计说明</button>}
            </div>
          </div>

          {view === "home" && <HomeView role={role} roleInfo={roleInfo} go={go} setDrawer={setDrawer} acknowledged={acknowledged} />}
          {view === "project" && <ProjectView go={go} />}
          {view === "script" && <ScriptWorkspace go={go} />}
          {view === "dramaturgy" && <DramaturgyWorkspace go={go} />}
          {view === "cue" && <CueWorkspace go={go} setDrawer={setDrawer} />}
          {moduleCopy[view] && !["script", "dramaturgy", "cue"].includes(view) && <ModuleView view={view} data={moduleCopy[view]!} go={go} setDrawer={setDrawer} />}
          {view === "events" && <EventsView published={published} openWizard={() => { setEventWizard(true); setEventStep(1); }} setDrawer={setDrawer} go={go} />}
          {view === "tasks" && <TasksView completed={completedTasks} completeTask={completeTask} progress={taskProgress} setDrawer={setDrawer} go={go} />}
          {view === "notifications" && <NotificationsView acknowledged={acknowledged} setAcknowledged={setAcknowledged} setDrawer={setDrawer} />}
          {view === "planning" && <PlanningViewPanel mode={planningView} setMode={setPlanningView} setDrawer={setDrawer} />}
          {view === "framework" && <FrameworkView go={go} />}
        </section>

        {drawer && <DetailDrawer type={drawer} close={() => setDrawer(null)} acknowledged={acknowledged} setAcknowledged={setAcknowledged} completeTask={completeTask} completed={completedTasks} />}

        <nav className={styles.bottomNav} aria-label="手机主导航">
          <button type="button" aria-current={view === "home" ? "page" : undefined} onClick={() => go("home")}><span>⌂</span>今日</button>
          <button type="button" aria-current={view === "project" ? "page" : undefined} onClick={() => go("project")}><span>◇</span>项目</button>
          <button type="button" aria-current={view === "tasks" ? "page" : undefined} onClick={() => go("tasks")}><span>✓</span>Task</button>
          <button type="button" aria-current={view === "notifications" ? "page" : undefined} onClick={() => go("notifications")}><span>◉</span>通知<em>3</em></button>
        </nav>
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
      {!accountPage && joinProjectOpen && <JoinProjectModal close={() => setJoinProjectOpen(false)} />}
    </main>
  );
}

function AccountCenter({
  page,
  setPage,
  close,
}: {
  page: AccountPage;
  setPage: (page: AccountPage) => void;
  close: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [twoFactor, setTwoFactor] = useState(true);
  const [desktopAlerts, setDesktopAlerts] = useState(true);
  const [weeklyDigest, setWeeklyDigest] = useState(false);
  const [activityVisible, setActivityVisible] = useState(true);
  const [presenceVisible, setPresenceVisible] = useState(false);

  const pageMeta: Record<AccountPage, { eyebrow: string; title: string; description: string }> = {
    profile: { eyebrow: "ACCOUNT", title: "个人信息", description: "管理你的基础资料，以及在项目协作中向其他成员展示的信息。" },
    security: { eyebrow: "SECURITY", title: "账号安全中心", description: "检查登录方式、双重验证和当前登录设备。" },
    preferences: { eyebrow: "PREFERENCES", title: "功能与设置", description: "调整语言、界面密度以及消息提醒方式。" },
    privacy: { eyebrow: "PRIVACY", title: "信息隐私与权限", description: "决定哪些账户信息和协作状态可以被其他成员看到。" },
    help: { eyebrow: "SUPPORT", title: "帮助与反馈", description: "查找使用说明，或把你的问题与建议发送给产品团队。" },
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
    <section className={styles.accountSettingsShell}>
      <header className={styles.accountSettingsTopbar}>
        <button type="button" className={styles.settingsBackButton} onClick={close}>
          <span>←</span> 返回工作区
        </button>
        <div className={styles.accountSettingsBrand}><i>林</i><b>CLICK-IN</b><span>个人中心</span></div>
        <div className={styles.accountSettingsUser}><span>林淼</span><i>林</i></div>
      </header>

      <div className={styles.accountSettingsLayout}>
        <aside className={styles.settingsSidebar}>
          <div className={styles.settingsIdentity}>
            <span>林</span>
            <p><b>林淼</b><small>linmiao@click-in.cn</small></p>
          </div>
          <nav aria-label="个人中心导航">
            <p>账户</p>
            {ACCOUNT_MENU_ITEMS.slice(0, 2).map((item) => (
              <button
                type="button"
                key={item.id}
                className={page === item.id ? styles.settingsNavActive : ""}
                onClick={() => setPage(item.id)}
              >
                <span>{item.id === "profile" ? "人" : "盾"}</span>{item.label}
              </button>
            ))}
            <p>偏好与隐私</p>
            {ACCOUNT_MENU_ITEMS.slice(2, 4).map((item) => (
              <button
                type="button"
                key={item.id}
                className={page === item.id ? styles.settingsNavActive : ""}
                onClick={() => setPage(item.id)}
              >
                <span>{item.id === "preferences" ? "调" : "锁"}</span>{item.label}
              </button>
            ))}
            <p>支持</p>
            <button
              type="button"
              className={page === "help" ? styles.settingsNavActive : ""}
              onClick={() => setPage("help")}
            >
              <span>?</span>帮助与反馈
            </button>
          </nav>
          <div className={styles.settingsWorkspaceNote}>
            <b>当前工作区</b>
            <span>海边的罗密欧</span>
            <small>个人设置对所有项目生效</small>
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
                    <label><span>显示名称</span><input defaultValue="林淼 · 舞监" /></label>
                    <label className={styles.settingsFullField}><span>个人简介</span><textarea defaultValue="制作人 / 舞台监督，负责跨部门排练协调与现场执行。" /></label>
                    <label><span>所在城市</span><input defaultValue="上海" /></label>
                    <label><span>联系电话</span><input defaultValue="+86 138 **** 6812" /></label>
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
                <div className={styles.sessionRow}><span>手</span><div><b>iPhone · Click-In App</b><small>上海 · 7 月 27 日 22:18</small></div><button type="button" className={styles.settingsTextButton}>退出</button></div>
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
                <div className={styles.settingsPreferenceRow}><div><b>已授权应用</b><span>当前没有第三方应用访问你的 Click-In 账号。</span></div><button type="button" className={styles.settingsTextButton}>查看详情</button></div>
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

          <div className={styles.settingsActions}>
            <span>{saved ? "✓ 更改已保存" : "设置仅影响你的个人账户"}</span>
            <button type="button" onClick={saveChanges}>{page === "help" ? "发送反馈" : "保存更改"}</button>
          </div>
        </main>
      </div>
    </section>
  );
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

function HomeView({ role, roleInfo, go, setDrawer, acknowledged }: {
  role: Role;
  roleInfo: { focus: string; secondary: string; note: string };
  go: (v: View) => void;
  setDrawer: (v: "task" | "cue" | "notification") => void;
  acknowledged: boolean;
}) {
  return (
    <div className={styles.contentStack}>
      <section className={styles.dashboardHero}>
        <div className={styles.dashboardHeroIntro}>
          <Badge tone="blue">{role}</Badge>
          <span className={styles.dashboardHeroLabel}>TODAY&apos;S CONTROL DESK</span>
          <h2>{roleInfo.focus}</h2>
          <p>{roleInfo.note}</p>
          <small>重点范围 · {roleInfo.secondary}</small>
        </div>
        <div className={styles.dashboardHeroData}>
          <div className={styles.dashboardMetrics}>
            <button type="button" onClick={() => go("notifications")}><strong>8</strong><span>待确认</span><small>较昨日 −3</small></button>
            <button type="button" onClick={() => go("tasks")}><strong>2</strong><span>风险 Task</span><small>1 项今日截止</small></button>
            <button type="button" onClick={() => go("events")}><strong>24</strong><span>距首演 / 天</span><small>3 个关键 Event</small></button>
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
          <div className={styles.panelHeading}><div><p className={styles.kicker}>MY TASKS</p><h2>我的 Task</h2></div><button type="button" onClick={() => go("tasks")}>全部 →</button></div>
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
          <div className={styles.panelHeading}><div><p className={styles.kicker}>KEY EVENTS</p><h2>关键 Event</h2></div><button type="button" onClick={() => go("events")}>全部 →</button></div>
          <div className={styles.eventRoadmap}>
            <button type="button" onClick={() => go("events")}><time><b>20</b><small>7 月</small></time><span><b>第三幕合成排练</b><small>今天 · 13:30 · 黑匣子 B</small></span><em>进行中</em></button>
            <button type="button" onClick={() => go("events")}><time><b>27</b><small>7 月</small></time><span><b>第一次全本联排</b><small>7 天后 · 排练厅 A</small></span><em>待准备</em></button>
            <button type="button" onClick={() => go("events")}><time><b>13</b><small>8 月</small></time><span><b>首演</b><small>24 天后 · 城市剧院</small></span><em>里程碑</em></button>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProjectView({ go }: { go: (v: View) => void }) {
  return (
    <div className={styles.contentStack}>
      <section className={styles.projectHero}>
        <div><Badge tone="green">联排期 · 正常</Badge><h2>从剧本到舞台，保持同一份项目事实</h2><p>两侧用于降低查找成本，不切断对象之间的联系。角色、Cue、资产、Event 和 Task 都可以在工作发生的上下文中直接打开。</p></div>
        <div className={styles.projectMetric}><ProgressRing value={74} /><span>首演倒计时</span><b>24 天</b></div>
      </section>
      <div className={styles.twoSides}>
        <section className={`${styles.sideMap} ${styles.scriptSide}`}>
          <div className={styles.sideMapHeader}><span>01</span><div><p>剧本侧</p><h2>内容如何被设计</h2></div></div>
          <div className={styles.moduleMap}>{SCRIPT_NAV.map((item) => <button type="button" key={item.id} onClick={() => go(item.id)}><b>{item.label}</b><small>{item.hint}</small><span>→</span></button>)}</div>
        </section>
        <section className={`${styles.sideMap} ${styles.stageSide}`}>
          <div className={styles.sideMapHeader}><span>02</span><div><p>舞台侧</p><h2>内容如何被执行</h2></div></div>
          <div className={styles.moduleMap}>{STAGE_NAV.map((item) => <button type="button" key={item.id} onClick={() => go(item.id)}><b>{item.label}</b><small>{item.hint}</small><span>→</span></button>)}</div>
        </section>
      </div>
      <section className={styles.relationshipStrip}>
        <div><span>剧本台词</span><i>→</i><span>Cue</span><i>→</i><span>Event / Timetable</span></div>
        <div><span>场次 / 角色</span><i>→</i><span>人员与 Call</span><i>→</i><span>Notification</span></div>
        <div><span>长线 Task</span><i>↔</i><span>多个 Event</span><i>↔</i><span>里程碑 / Gantt</span></div>
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
            {(() => { const scene = scenes.find((item) => item.id === selected) ?? scenes[2]; return <><h3>{scene.no} · {scene.name}</h3><label><span>梗概</span><textarea defaultValue={scene.synopsis} /></label><label><span>行动线</span><input defaultValue={scene.action} /></label><label><span>音乐 / 舞台提示</span><input defaultValue="海浪主题 · 灯塔亮起" /></label><button type="button" onClick={() => go("script")}>在剧本中定位 →</button></>; })()}
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
          <button type="button" className={styles.cueSaveButton}>保存 Cue</button>
        </aside>
      </section>
    </div>
  );
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

function EventsView({ published, openWizard, setDrawer, go }: { published: boolean; openWizard: () => void; setDrawer: (v: "task" | "cue") => void; go: (v: View) => void }) {
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
          <article><time><b>20</b><small>7 月</small></time><div><div><Badge tone="blue">排练</Badge><Badge tone="amber">需要确认</Badge></div><h3>第三幕合成排练</h3><p>13:30–18:00 · 黑匣子 B · 18 人</p><div className={styles.inlineActions}><button type="button" onClick={() => go("planning")}>Timetable <span>→</span></button><button type="button" onClick={() => setDrawer("task")}>6 个 Task <span>→</span></button><button type="button" onClick={() => setDrawer("cue")}>24 个 Cue <span>→</span></button></div></div><span className={styles.eventStatus}>8 人未确认</span></article>
          <article><time><b>22</b><small>7 月</small></time><div><div><Badge tone="neutral">围读</Badge></div><h3>全本节奏围读</h3><p>14:00–17:00 · 排练厅 2 · 全体演员</p><div className={styles.inlineActions}><button type="button" onClick={() => go("script")}>关联剧本 V12 <span>→</span></button><button type="button" onClick={() => setDrawer("task")}>3 个 Task <span>→</span></button></div></div><span className={styles.eventStatus}>草稿</span></article>
          <article><time><b>13</b><small>8 月</small></time><div><div><Badge tone="red">演出</Badge></div><h3>首演</h3><p>19:30–21:45 · 城市剧院 · 全体</p><div className={styles.inlineActions}><button type="button" onClick={() => go("planning")}>演出执行表 <span>→</span></button><button type="button" onClick={() => go("people")}>人员与 Call <span>→</span></button></div></div><span className={styles.eventStatus}>筹备中</span></article>
        </div>
      </section>
    </div>
  );
}

function TasksView({ completed, completeTask, progress, setDrawer, go }: { completed: string[]; completeTask: (id: string) => void; progress: number; setDrawer: (v: "task") => void; go: (v: View) => void }) {
  const tasks = [
    { id: "t1", name: "确认舞台尺寸与承重点", owner: "舞美组", due: "7 月 14 日" },
    { id: "t2", name: "完成地胶采购", owner: "制作组", due: "7 月 21 日" },
    { id: "t3", name: "铺设并完成安全检查", owner: "舞台组", due: "7 月 25 日" },
    { id: "t4", name: "联排后复检", owner: "舞监组", due: "8 月 1 日" },
  ];
  return (
    <div className={styles.contentStack}>
      <section className={styles.taskHero}>
        <div><Badge tone="amber">长线 Task</Badge><h2>舞台地胶采购与铺设</h2><p>父任务负责长期目标；子任务可由不同部门承担，并分别关联 Event 与里程碑。</p><div className={styles.taskMeta}><span>负责人：陈嘉</span><span>协作：舞美 / 舞台 / 制作</span><span>关联 3 个 Event</span></div></div>
        <ProgressRing value={progress} />
      </section>
      <div className={styles.taskLayout}>
        <section className={styles.panel}>
          <div className={styles.panelHeading}><div><p className={styles.kicker}>SUBTASKS</p><h2>阶段与子任务</h2></div><button type="button" onClick={() => setDrawer("task")}>打开详情</button></div>
          <div className={styles.taskChecklist}>{tasks.map((task, index) => {
            const done = completed.includes(task.id);
            return <div key={task.id} className={done ? styles.taskDone : ""}><button type="button" className={styles.taskCheck} aria-label={`${done ? "恢复" : "完成"}${task.name}`} onClick={() => completeTask(task.id)}>{done ? "✓" : ""}</button><button type="button" className={styles.taskMain} onClick={() => setDrawer("task")}><span><small>0{index + 1}</small><b>{task.name}</b></span><span><small>{task.owner}</small><b>{task.due}</b></span></button></div>;
          })}</div>
        </section>
        <aside className={styles.panel}>
          <p className={styles.kicker}>LINKED OBJECTS</p><h2>关联而非复制</h2>
          <div className={styles.linkedObjects}><button type="button" onClick={() => go("events")}><Badge tone="blue">Event</Badge><span><b>第三幕合成排练</b><small>7 月 20 日</small></span></button><button type="button" onClick={() => go("events")}><Badge tone="red">Event</Badge><span><b>第一次全本联排</b><small>7 月 27 日</small></span></button><button type="button" onClick={() => go("planning")}><Badge tone="amber">里程碑</Badge><span><b>舞台可交付</b><small>7 月 25 日</small></span></button><button type="button" onClick={() => go("materials")}><Badge>物料</Badge><span><b>黑色舞蹈地胶 × 12</b><small>采购中</small></span></button></div>
        </aside>
      </div>
    </div>
  );
}

function NotificationsView({ acknowledged, setAcknowledged, setDrawer }: { acknowledged: boolean; setAcknowledged: (v: boolean) => void; setDrawer: (v: "notification") => void }) {
  return (
    <div className={styles.contentStack}>
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

function PlanningViewPanel({ mode, setMode, setDrawer }: { mode: PlanningView; setMode: (m: PlanningView) => void; setDrawer: (v: "task" | "cue") => void }) {
  const [selectedEventId, setSelectedEventId] = useState("e-tech");
  const [personFilter, setPersonFilter] = useState("lin");
  const [taskStatus, setTaskStatus] = useState<Record<string, LinkedPlanTask["status"]>>({});

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
      <section className={styles.planningRelation}>
        <span>Event</span><i>→</i><span>Schedule Item</span><i>→</i><span>Task / Todo</span>
        <p>同一份日期、人员与状态信息，分别生成日历总览、项目甘特和 Event 当天 Rundown。</p>
      </section>
      <div className={styles.viewTabs}>
        <button type="button" aria-pressed={mode === "calendar"} onClick={() => setMode("calendar")}><b>Calendar</b><small>Event · Task · Milestone</small></button>
        <button type="button" aria-pressed={mode === "gantt"} onClick={() => setMode("gantt")}><b>Gantt</b><small>项目阶段与重要排期</small></button>
        <button type="button" aria-pressed={mode === "timetable"} onClick={() => setMode("timetable")}><b>Rundown / Timetable</b><small>Event 当天分钟级执行</small></button>
      </div>
      {mode === "calendar" && <CalendarMock openRundown={openRundown} setDrawer={setDrawer} />}
      {mode === "gantt" && <GanttMock openRundown={openRundown} setDrawer={setDrawer} />}
      {mode === "timetable" && <TimetableMock selectedEventId={selectedEventId} setSelectedEventId={setSelectedEventId} personFilter={personFilter} setPersonFilter={setPersonFilter} taskStatus={taskStatus} toggleTask={toggleTask} setDrawer={setDrawer} />}
    </div>
  );
}

function CalendarMock({ openRundown, setDrawer }: { openRundown: (id: string) => void; setDrawer: (v: "task" | "cue") => void }) {
  const days = Array.from({ length: 28 }, (_, i) => i + 7);
  return <section className={styles.panel}><div className={styles.panelHeading}><div><p className={styles.kicker}>2026 年 7 月</p><h2>项目日历</h2></div><div className={styles.legend}><span><i className={styles.legendEvent} />Event</span><span><i className={styles.legendTask} />Task</span><span><i className={styles.legendMilestone} />Milestone</span></div></div><div className={styles.calendarWeek}>{["一", "二", "三", "四", "五", "六", "日"].map((d) => <span key={d}>周{d}</span>)}</div><div className={styles.calendarGrid}>{days.map((day) => <div key={day} className={day === 20 ? styles.todayCell : ""}><b>{day > 31 ? day - 31 : day}</b>{day === 14 && <button type="button" className={styles.taskEvent} onClick={() => setDrawer("task")}>Task · 地胶尺寸确认</button>}{day === 20 && <><button type="button" className={styles.mainEvent} onClick={() => openRundown("e-tech")}>Event · 第三幕合成排练</button><button type="button" className={styles.taskEvent} onClick={() => setDrawer("cue")}>Task · Cue 联调</button></>}{day === 25 && <button type="button" className={styles.milestoneEvent} onClick={() => setDrawer("task")}>◆ 舞台可交付</button>}{day === 27 && <button type="button" className={styles.mainEvent} onClick={() => openRundown("e-run")}>Event · 第一次全本联排</button>}</div>)}</div></section>;
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
        <div><Badge tone={completedCount === relevantTaskIds.length ? "green" : "amber"}>{completedCount} / {relevantTaskIds.length} Task 完成</Badge><Badge>{event.milestone}</Badge></div>
      </div>
      <div className={styles.rundownControls}>
        <label><span>Event</span><select value={event.id} onChange={(e) => setSelectedEventId(e.target.value)}>{PLANNING_EVENTS.map((item) => <option value={item.id} key={item.id}>{item.date} · {item.title}</option>)}</select></label>
        <label><span>查看工作流</span><select value={personFilter} onChange={(e) => setPersonFilter(e.target.value)}><option value="all">全部成员</option>{PLANNING_PEOPLE.map((person) => <option value={person.id} key={person.id}>{person.name} · {person.department}</option>)}</select></label>
        <p><b>{personName}</b><small>可查看其当前工作、对接人和工作地点</small></p>
      </div>

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

function DetailDrawer({ type, close, acknowledged, setAcknowledged, completeTask, completed }: { type: "task" | "cue" | "notification"; close: () => void; acknowledged: boolean; setAcknowledged: (v: boolean) => void; completeTask: (id: string) => void; completed: string[] }) {
  return <aside className={styles.drawer} aria-label="关联详情" data-dismiss-surface="detail-drawer"><div className={styles.drawerHeader}><div><p>{type === "task" ? "TASK DETAIL" : type === "cue" ? "CUE DETAIL" : "NOTIFICATION DETAIL"}</p><h2>{type === "task" ? "确认第三幕转场动线" : type === "cue" ? "LX 38 · 海浪淡出" : "第三幕排练时间调整"}</h2></div><button type="button" onClick={close} aria-label="关闭详情">×</button></div>{type === "task" && <div className={styles.drawerBody}><Badge tone="amber">今天 18:00 截止</Badge><p>确认第三幕结束后，从海边平台到终场站位的转场路径，并与灯光暗场时间保持一致。</p><dl><div><dt>负责人</dt><dd>林淼（舞监）</dd></div><div><dt>关联 Event</dt><dd>第三幕合成排练、第一次全本联排</dd></div><div><dt>关联内容</dt><dd>第三幕 · LX 42 · 舞台右侧平台</dd></div></dl><label className={styles.drawerCheck}><input type="checkbox" checked={completed.includes("drawer-task")} onChange={() => completeTask("drawer-task")} /><span><b>标记为完成</b><small>完成后通知协作部门</small></span></label></div>}{type === "cue" && <div className={styles.drawerBody}><div><Badge tone="blue">灯光 Cue</Badge> <Badge>已同步 Timetable</Badge></div><blockquote>“潮水已经退去，但盐还留在我们身上。”</blockquote><dl><div><dt>动作</dt><dd>海浪纹理从 45% 淡出至 0%</dd></div><div><dt>时长</dt><dd>5 秒（原 3 秒）</dd></div><div><dt>关联部门</dt><dd>灯光、多媒体、音响</dd></div></dl><button type="button" className={styles.secondaryButton}>在剧本中定位</button></div>}{type === "notification" && <div className={styles.drawerBody}><Badge tone="amber">必须确认</Badge><p>第三幕合成排练由 14:00 调整至 13:30。你的 Call Time 为 13:00，地点仍为黑匣子 B。</p><dl><div><dt>已确认</dt><dd>{acknowledged ? "15 / 18 人" : "10 / 18 人"}</dd></div><div><dt>未确认</dt><dd>{acknowledged ? "王屿、周嘉、韩松" : "王屿、周嘉、韩松等 8 人"}</dd></div><div><dt>最后提醒</dt><dd>10 分钟前 · 站内通知</dd></div></dl>{!acknowledged && <button type="button" className={styles.primaryButton} onClick={() => setAcknowledged(true)}>我已知悉并确认</button>}</div>}</aside>;
}

function EventWizard({ step, setStep, close, publish }: { step: number; setStep: (s: number) => void; close: () => void; publish: () => void }) {
  const [selected, setSelected] = useState(["场地与人员确认", "Call Sheet 生成", "技术部门需求确认", "排练后 Notes"]);
  const templates = ["场地与人员确认", "Call Sheet 生成", "技术部门需求确认", "排练后 Notes"];
  return <div className={styles.modalBackdrop} role="presentation"><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="event-wizard-title"><div className={styles.modalHeader}><div><p>CREATE EVENT · STEP {step} / 3</p><h2 id="event-wizard-title">{step === 1 ? "定义 Event" : step === 2 ? "确认系统建议的 Task" : "发布与通知"}</h2></div><button type="button" onClick={close} aria-label="关闭">×</button></div><div className={styles.stepper}><i className={step >= 1 ? styles.stepActive : ""} /><i className={step >= 2 ? styles.stepActive : ""} /><i className={step >= 3 ? styles.stepActive : ""} /></div>{step === 1 && <div className={styles.formGrid}><label><span>Event 类型</span><select defaultValue="rehearsal"><option value="rehearsal">排练</option><option>围读</option><option>演出</option><option>会议</option></select></label><label><span>标题</span><input defaultValue="首演技术合成" /></label><label><span>日期与时间</span><input defaultValue="2026-07-30 13:00–21:00" /></label><label><span>地点</span><input defaultValue="城市剧院 · 主舞台" /></label><label className={styles.fullField}><span>参与范围</span><input defaultValue="全体演员、舞台、灯光、音响、多媒体、服化" /></label></div>}{step === 2 && <div><p className={styles.modalLead}>系统根据“技术合成”模板建议以下 Task。发布前由创建者确认负责人、截止时间和通知对象。</p><div className={styles.templateTasks}>{templates.map((task, i) => <label key={task}><input type="checkbox" checked={selected.includes(task)} onChange={() => setSelected((prev) => prev.includes(task) ? prev.filter((x) => x !== task) : [...prev, task])} /><span><b>{task}</b><small>{["制作组 · Event 前 3 天", "舞监组 · Event 前 1 天", "各部门 POC · Event 前 2 天", "舞监组 · Event 后 2 小时"][i]}</small></span><Badge>{i === 2 ? "技术需求类型" : "标准 Task"}</Badge></label>)}</div></div>}{step === 3 && <div className={styles.publishSummary}><div><span>◇</span><p><b>1 个 Event</b><small>首演技术合成</small></p></div><div><span>✓</span><p><b>{selected.length} 个 Task</b><small>保留负责人和截止时间</small></p></div><div><span>◉</span><p><b>18 位成员</b><small>生成站内 Notification</small></p></div><p>其中 Call 和时间变更属于“必须确认”；普通 Task 更新属于“仅告知”。</p></div>}<div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={step === 1 ? close : () => setStep(step - 1)}>{step === 1 ? "取消" : "上一步"}</button><button type="button" className={styles.primaryButton} onClick={step === 3 ? publish : () => setStep(step + 1)}>{step === 3 ? "发布 Event" : "继续"}</button></div></section></div>;
}
