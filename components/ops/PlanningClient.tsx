"use client";

/**
 * 计划与日程（v3 原型 planning 三视图）：
 *   ① 项目日历 —— 月历统一展示事件、任务（未绑定 event 的）、里程碑与阶段
 *   ② 任务甘特 —— 阶段背景带 + 任务时间条（有效起止：自身→schedule→event 解析链），可拖拽改期
 *   ③ 执行日程 —— 按事件的多部门 rundown（schedule 条目 + 绑定 event 未绑 schedule 的任务）
 *
 * 阶段（phase）的管理面也收在本面板（管理阶段弹窗）：创建门 = phase/*@create ∨
 * 部门 POC（policy 开关，活引用判定），与 API 同门；此处布尔仅控 UI 显隐。
 */

import { useEffect, useState } from "react";
import CalendarView from "./planning/CalendarView";
import PhaseManageModal from "./planning/PhaseManageModal";
import TaskGanttView from "./planning/TaskGanttView";
import TimetableView from "./planning/TimetableView";
import { readPref, writePref } from "./planning/prefs";
import type { Props } from "./planning/types";
import styles from "@/components/ops/planning.module.css";

// ─── 主组件：三视图 tab ────────────────────────────────────────────────────────

export default function PlanningClient(props: Props) {
  const [mode, setMode] = useState<"calendar" | "gantt" | "timetable">("calendar");
  const [modeRestored, setModeRestored] = useState(false);

  useEffect(() => {
    const saved = readPref(`planning-last-view:${props.productionId}`);
    if (saved === "calendar" || saved === "gantt" || saved === "timetable") setMode(saved);
    setModeRestored(true);
  }, [props.productionId]);

  useEffect(() => {
    if (!modeRestored) return;
    writePref(`planning-last-view:${props.productionId}`, mode);
  }, [mode, modeRestored, props.productionId]);
  const [phaseModalOpen, setPhaseModalOpen] = useState(false);
  const { phasePerm } = props;
  const showPhaseManage =
    phasePerm.canCreate || phasePerm.canEdit || phasePerm.canDelete
    || (phasePerm.deptPocEnabled && phasePerm.pocDeptIds.length > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {showPhaseManage && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={() => setPhaseModalOpen(true)}
            style={{
              fontSize: 11, fontWeight: 700, padding: "7px 14px", borderRadius: 8,
              border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", cursor: "pointer",
            }}
          >
            管理阶段（{props.phases.length}）
          </button>
        </div>
      )}
      {/* viewTabs（原型：三等宽撑满、62px 卡、选中 ink 反色） */}
      <div className={styles.planningViewTabs}>
        {([
          ["calendar", "项目日历", "事件、任务、里程碑与阶段"],
          ["gantt", "任务甘特", "阶段背景带与任务周期"],
          ["timetable", "执行日程", "按日期查看、导入与编辑"],
        ] as const).map(([id, label, hint]) => (
          <button
            key={id}
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
            style={{
              border: `1px solid ${mode === id ? "var(--ink)" : "var(--line)"}`,
              borderRadius: 10, background: mode === id ? "var(--ink)" : "var(--surface)",
              minHeight: 62, padding: "12px 15px", display: "flex", flexDirection: "column", minWidth: 0,
              textAlign: "left", cursor: "pointer",
            }}
          >
            <b style={{ fontSize: 12, color: mode === id ? "#fff" : "var(--ink)" }}>{label}</b>
            <small className={styles.planningTabHint} style={{ color: mode === id ? "#b9c8c4" : "var(--muted)" }}>{hint}</small>
          </button>
        ))}
      </div>

      {mode === "calendar" && <CalendarView {...props} />}
      {mode === "gantt" && <TaskGanttView {...props} />}
      {mode === "timetable" && <TimetableView {...props} />}

      {phaseModalOpen && (
        <PhaseManageModal
          productionId={props.productionId}
          phases={props.phases}
          milestones={props.milestones}
          deptOptions={props.deptOptions}
          perm={phasePerm}
          onClose={() => setPhaseModalOpen(false)}
        />
      )}
    </div>
  );
}
