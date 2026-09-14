"use client";

import { useState } from "react";
import styles from "@/components/ops/planning.module.css";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import type { EventScheduleItemWithParticipants, EventTechReq } from "@/lib/ops/event-db";
import BoundedTimePicker from "./BoundedTimePicker";
import { hhmm, withTime } from "./date";
import type { RundownColumn, RundownEntrySelection } from "./rundown-types";

const RUNDOWN_COLORS = ["#dce9e9", "#edf0e5", "#f2e3d6", "#eee5f0", "#e8e6f7", "#f5dfd8"];

export default function RundownEntryEditor({ selection, item, task, lanes, laneIds, color, onSave, onClose }: {
  selection: RundownEntrySelection;
  item: EventScheduleItemWithParticipants | null;
  task: EventTechReq | null;
  lanes: RundownColumn[];
  laneIds: string[];
  color: string;
  onSave: (draft: { title: string; description: string; start: string; end: string; location: string; itemType: string; status: string; laneIds: string[]; color: string }) => Promise<void>;
  onClose: () => void;
}) {
  const source = item ?? task;
  const startIso = item?.startTime ?? task?.effectiveStartTime ?? "";
  const endIso = item?.endTime ?? task?.effectiveEndTime ?? "";
  const [title, setTitle] = useState(source?.title ?? "");
  const [description, setDescription] = useState(item?.notes ?? task?.description ?? "");
  const [start, setStart] = useState(startIso ? hhmm(startIso) : "09:00");
  const [end, setEnd] = useState(endIso ? hhmm(endIso) : "10:00");
  const [location, setLocation] = useState(item?.location ?? "");
  const [itemType, setItemType] = useState(item?.itemType ?? "task");
  const [status, setStatus] = useState(task?.status ?? "pending");
  const [selectedLaneIds, setSelectedLaneIds] = useState<string[]>(laneIds);
  const [selectedColor, setSelectedColor] = useState(color);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!source || !startIso || !endIso || !title.trim()) return;
    const nextStart = withTime(startIso, start);
    const nextEnd = withTime(endIso, end);
    if (new Date(nextEnd) <= new Date(nextStart)) { setError("结束时间需晚于开始时间"); return; }
    setSaving(true); setError(null);
    try {
      await onSave({ title: title.trim(), description, start: nextStart, end: nextEnd, location, itemType, status, laneIds: selectedLaneIds, color: selectedColor });
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return (
    <aside className={styles.entryEditor} aria-label={`${selection.kind === "item" ? "日程" : "任务"}块编辑`}>
      <div className={styles.inlineEditorHeader}><div><small>{selection.kind === "item" ? "SCHEDULE" : "TASK"}</small><b>编辑事项块</b></div><button type="button" onClick={onClose} aria-label="关闭事项编辑">×</button></div>
      <label className={styles.inlineField}>标题<input value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label className={styles.inlineField}>说明<textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <div className={styles.twoFields}><BoundedTimePicker label="开始" value={start} onChange={setStart} /><BoundedTimePicker label="结束" value={end} onChange={setEnd} /></div>
      {item ? <>
        <label className={styles.inlineField}>类型<OverflowSafeSelect value={itemType} onChange={event => setItemType(event.target.value)}><option value="run">执行</option><option value="call">集合</option><option value="task">任务</option><option value="break">休息</option><option value="notes">备注</option><option value="custom">自定义</option></OverflowSafeSelect></label>
        <label className={styles.inlineField}>地点<input value={location} onChange={event => setLocation(event.target.value)} /></label>
      </> : <label className={styles.inlineField}>状态<OverflowSafeSelect value={status} onChange={event => setStatus(event.target.value)}><option value="awaiting">待确认</option><option value="pending">待处理</option><option value="in_progress">进行中</option><option value="done">完成</option></OverflowSafeSelect></label>}
      <div className={styles.optionSection}><b>显示在人员组（可多选）</b><div className={styles.multiPicker}>{lanes.map(lane => <button key={lane.id} type="button" className={`${styles.toggleChip} ${selectedLaneIds.includes(lane.id) ? styles.toggleChipActive : ""}`} onClick={() => setSelectedLaneIds(current => current.includes(lane.id) ? current.filter(id => id !== lane.id) : [...current, lane.id])}>{lane.name}</button>)}</div></div>
      <div className={styles.optionSection}><b>事项颜色</b><div className={styles.colorPicker}>{RUNDOWN_COLORS.map(option => <button key={option} type="button" aria-label={`颜色 ${option}`} aria-pressed={selectedColor === option} onClick={() => setSelectedColor(option)} style={{ background: option }} />)}</div></div>
      {error && <p className={styles.editorError}>{error}</p>}
      <button type="button" className={styles.primaryEditorAction} disabled={saving} onClick={submit}>{saving ? "保存中…" : "保存事项"}</button>
    </aside>
  );
}
