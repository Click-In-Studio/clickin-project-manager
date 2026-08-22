"use client";

/**
 * 任务详情页（task-first，2026-08-15 重设计）：
 *   - 顶部 breadcrumb（任务 › 任务详情）+ 统一 PageHeader 语汇
 *   - 主栏 = 任务本体（信息/时间/负责人/状态；awaiting+POC 走确认编辑流）
 *   - 侧栏 = 关联（事件/绑定日程条目/里程碑/依赖/飞书群）——event 退为辅
 */

import React, { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import SmartTextarea from "@/components/SmartTextarea";
import SmartText, { scriptRefTextPlugin } from "@/components/SmartText";
import PageHeader, { PAGE_TITLE_FONT, PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import AccessRequestModal from "@/components/AccessRequestModal";
import DropdownPicker from "@/components/DropdownPicker";
import styles from "@/components/my-pages.module.css";
import type { EventTechReq, EventScheduleItem, ProductionEvent, TaskDependencyRef } from "@/lib/event-db";
import { fmtTime, fmtDateTime } from "@/lib/tz";

const SCHEDULE_ITEM_TYPE_LABELS: Record<string, string> = {
  scene_rehearsal: "场景排练",
  fitting: "服装",
  sound_check: "音响",
  tech_rehearsal: "技排",
  meeting: "会议",
  break: "休息",
  custom: "其他",
};

const STATUS_OPTIONS = [
  { value: "pending",     label: "待处理" },
  { value: "in_progress", label: "进行中" },
  { value: "done",        label: "完成"   },
];
const STATUS_LABELS: Record<string, string> = {
  awaiting: "待确认", pending: "待处理", in_progress: "进行中", done: "完成",
};

/** 状态徽章：主题色板（与任务面板同门） */
function statusBadgeStyle(status: string): React.CSSProperties {
  if (status === "awaiting") return { background: "#eee5f0", color: "#7a5a86" };
  if (status === "pending") return { background: "var(--warn-soft)", color: "var(--warn)" };
  if (status === "in_progress") return { background: "var(--script-soft)", color: "var(--script)" };
  if (status === "done") return { background: "var(--success-soft)", color: "var(--success)" };
  return { background: "var(--paper)", color: "var(--muted)" };
}

function fmtItemTime(item: EventScheduleItem, singleDay: boolean): string {
  if (!item.startTime) return "";
  return singleDay ? fmtTime(item.startTime) : fmtDateTime(item.startTime);
}

function isSingleDay(event: ProductionEvent | null): boolean {
  if (!event?.startTime || !event.endTime) return false;
  return event.startTime.slice(0, 10) === event.endTime.slice(0, 10);
}

type Props = {
  req: EventTechReq;
  /** null = 未绑定 event 的独立任务 */
  event: ProductionEvent | null;
  scheduleItems: EventScheduleItem[];
  deptName: string | null;
  deptPeople: { userId: string; name: string }[];
  allPeople?: { userId: string; name: string }[];
  /** 当前绑定的阶段（展示用） */
  phases: { id: string; name: string; startDate: string; endDate: string | null; deptName: string | null }[];
  /** 全量阶段（编辑面选项） */
  phaseOptions: { id: string; name: string; startDate: string; endDate: string | null; deptName: string | null }[];
  /** 依赖候选：同 production 其他任务（编辑面选项） */
  taskOptions: { id: string; title: string; status: string }[];
  blockedBy: TaskDependencyRef[];
  blocks: TaskDependencyRef[];
  isPocOfDept: boolean;
  isAssignee: boolean;
  canViewFull: boolean;
  productionId: string;
};

/** ISO ↔ datetime-local（本地时区） */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type AccessResult =
  | { canAccess: true; level?: string }
  | { canAccess: false; canSelfConfirm: true; selfConfirmLevel: "edit" | "manage" }
  | { canAccess: false; canSelfConfirm: false };

// ── 样式基元（页面统一语汇）────────────────────────────────────────────────────

const PANEL: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 13, padding: 22,
};
const SECTION_KICKER: React.CSSProperties = {
  margin: "0 0 12px", fontSize: 10, fontWeight: 700,
  letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)",
};
const FIELD_LABEL: React.CSSProperties = {
  display: "block", marginBottom: 5, fontSize: 10, fontWeight: 700,
  letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)",
};
const FIELD_INPUT: React.CSSProperties = {
  width: "100%", border: "1px solid var(--line)", borderRadius: 8,
  padding: "9px 12px", fontSize: 12, color: "var(--ink)",
  background: "var(--paper)", outline: "none",
};
const CHIP: React.CSSProperties = {
  borderRadius: 999, padding: "4px 11px", fontSize: 11, fontWeight: 600,
  background: "var(--surface-2)", color: "var(--ink)",
};

// ── 飞书群（chat API 仍为 event 语境——无绑定任务暂不提供建群）──────────────────

function ReqChatSection({
  req, event, productionId, canManage, onChatIdSet,
}: {
  req: EventTechReq;
  event: ProductionEvent;
  productionId: string;
  canManage: boolean;
  onChatIdSet: (chatId: string) => void;
}) {
  const [bindQuery, setBindQuery] = useState("");
  const [bindResults, setBindResults] = useState<{ chatId: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showBind, setShowBind] = useState(false);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${event.id}/tech-reqs/${req.id}/chat`;

  async function createChat() {
    if (!confirm("确定为此任务创建飞书群吗？")) return;
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const data = await res.json();
      if (data.chatId) onChatIdSet(data.chatId);
      else alert(data.error ?? "建群失败");
    } finally { setBusy(false); }
  }

  async function searchBindable() {
    if (!bindQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/chats/bindable?q=${encodeURIComponent(bindQuery)}`);
      const data = await res.json();
      setBindResults(data.chats ?? []);
    } finally { setSearching(false); }
  }

  async function bindChat(chatId: string) {
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bind", chatId }),
      });
      const data = await res.json();
      if (data.chatId) { onChatIdSet(data.chatId); setShowBind(false); }
      else alert(data.error ?? "绑定失败");
    } finally { setBusy(false); }
  }

  if (req.chatId) {
    return (
      <span style={{ ...CHIP, background: "var(--script-soft)", color: "var(--script)" }}>已绑定飞书群</span>
    );
  }

  if (!canManage) return null;

  const SMALL_BTN: React.CSSProperties = {
    borderRadius: 8, padding: "7px 12px", fontSize: 11, fontWeight: 700,
    border: "1px solid var(--line)", background: "transparent",
    color: "var(--ink)", cursor: "pointer",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={createChat} disabled={busy} style={{ ...SMALL_BTN, opacity: busy ? 0.5 : 1 }}>
          {busy ? "…" : "创建飞书群"}
        </button>
        <button onClick={() => setShowBind(b => !b)} disabled={busy} style={SMALL_BTN}>
          绑定现有群
        </button>
      </div>
      {showBind && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={bindQuery}
              onChange={e => setBindQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && searchBindable()}
              placeholder="搜索群名…"
              style={{ ...FIELD_INPUT, flex: 1 }}
            />
            <button onClick={searchBindable} disabled={searching} style={{ ...SMALL_BTN, opacity: searching ? 0.5 : 1 }}>
              {searching ? "…" : "搜索"}
            </button>
          </div>
          {bindResults !== null && (
            bindResults.length === 0
              ? <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>未找到可绑定的群</p>
              : <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {bindResults.map(c => (
                    <button key={c.chatId} onClick={() => bindChat(c.chatId)} disabled={busy} style={{
                      textAlign: "left", borderRadius: 8, padding: "8px 12px", fontSize: 12,
                      border: "1px solid var(--line)", background: "var(--paper)",
                      color: "var(--ink)", cursor: "pointer", opacity: busy ? 0.5 : 1,
                    }}>
                      {c.name}
                    </button>
                  ))}
                </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export default function ReqDetailClient({
  req: initialReq, event, scheduleItems,
  deptName, deptPeople, allPeople,
  phases, phaseOptions, taskOptions, blockedBy, blocks,
  isPocOfDept, isAssignee, canViewFull,
  productionId,
}: Props) {
  const router = useRouter();
  const [req, setReq] = useState(initialReq);
  const [title, setTitle] = useState(initialReq.title);
  const [description, setDescription] = useState(initialReq.description);
  const [assignees, setAssignees] = useState(initialReq.assignees);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // router.refresh() 后服务端重投喂 → 本地跟进
  useEffect(() => {
    setReq(initialReq);
    setTitle(initialReq.title);
    setDescription(initialReq.description);
    setAssignees(initialReq.assignees);
  }, [initialReq]);

  // ── inline 编辑态（编辑按钮常驻；无权限走自确认/申请分流）──────────────────
  const [editMode, setEditMode] = useState(false);
  const [accessChecking, setAccessChecking] = useState(false);
  const [selfConfirmLevel, setSelfConfirmLevel] = useState<"edit" | "manage" | null>(null);
  const [selfConfirming, setSelfConfirming] = useState(false);
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [editStartTime, setEditStartTime] = useState("");
  const [editEndTime, setEditEndTime] = useState("");
  const [editPhaseIds, setEditPhaseIds] = useState<Set<string>>(new Set());
  const [editBlockedByIds, setEditBlockedByIds] = useState<Set<string>>(new Set());
  // 事件改绑：可挂载事件列表懒加载（create-options 的服务端过滤复用）
  const [editEventId, setEditEventId] = useState("");
  const [editScheduleItemIds, setEditScheduleItemIds] = useState<Set<string>>(new Set());
  const [attachableEvents, setAttachableEvents] = useState<
    { id: string; title: string; startTime: string | null; requiresPocDept: boolean }[] | null
  >(null);
  const [editScheduleOptions, setEditScheduleOptions] = useState<{ id: string; title: string; startTime: string | null }[]>([]);

  function enterEditMode() {
    setTitle(req.title);
    setDescription(req.description);
    setAssignees(req.assignees);
    setEditStartTime(isoToLocalInput(req.startTime));
    setEditEndTime(isoToLocalInput(req.endTime));
    setEditPhaseIds(new Set(req.phaseIds));
    setEditBlockedByIds(new Set(blockedBy.map(d => d.id)));
    setEditEventId(req.eventId ?? "");
    setEditScheduleItemIds(new Set(req.scheduleItemIds));
    setError(null);
    setEditMode(true);
    if (!attachableEvents) {
      fetch(`${BASE_PATH}/api/production/${productionId}/tasks/create-options`)
        .then(r => r.json())
        .then((j: { events?: { id: string; title: string; startTime: string | null; requiresPocDept: boolean }[] }) => {
          setAttachableEvents(j.events ?? []);
        })
        .catch(() => setAttachableEvents([]));
    }
  }

  // 编辑态选中事件 → 拉取其 schedule 条目；换事件清空已选（原事件保留当前绑定）
  useEffect(() => {
    if (!editMode || !editEventId) { setEditScheduleOptions([]); return; }
    if (editEventId === (req.eventId ?? "")) {
      setEditScheduleOptions(scheduleItems.map(it => ({ id: it.id, title: it.title, startTime: it.startTime })));
      return;
    }
    setEditScheduleItemIds(new Set());
    let cancelled = false;
    fetch(`${BASE_PATH}/api/production/${productionId}/events/${editEventId}/schedule`)
      .then(r => r.json())
      .then((j: { items?: { id: string; title: string; startTime: string | null }[] }) => {
        if (!cancelled) setEditScheduleOptions(j.items ?? []);
      })
      .catch(() => { if (!cancelled) setEditScheduleOptions([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, editEventId]);

  async function handleEditClick() {
    setAccessChecking(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${req.id}/access`);
      if (!res.ok) { setRequestModalOpen(true); return; }
      const data = await res.json() as AccessResult;
      if (data.canAccess) enterEditMode();
      else if (data.canSelfConfirm) setSelfConfirmLevel(data.selfConfirmLevel);
      else setRequestModalOpen(true);
    } catch {
      setRequestModalOpen(true);
    } finally {
      setAccessChecking(false);
    }
  }

  async function selfConfirmAndEdit() {
    if (!selfConfirmLevel) return;
    setSelfConfirming(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${req.id}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "self_confirm", level: selfConfirmLevel }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? "自我确认失败");
        return;
      }
      setSelfConfirmLevel(null);
      enterEditMode();
    } finally {
      setSelfConfirming(false);
    }
  }

  async function saveEdit() {
    if (!title.trim()) { setError("请填写任务名称"); return; }
    if (editStartTime && editEndTime && new Date(editEndTime) < new Date(editStartTime)) {
      setError("结束时间不能早于开始时间");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const base = `${BASE_PATH}/api/production/${productionId}/tasks/${req.id}`;
      const eventChanged = (editEventId || null) !== (req.eventId ?? null);
      const patchRes = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description,
          startTime: editStartTime ? new Date(editStartTime).toISOString() : null,
          endTime: editEndTime ? new Date(editEndTime).toISOString() : null,
          // 换绑/解绑才提交（服务端有目标事件挂载资格门；换绑会清旧 schedule 绑定）
          ...(eventChanged ? { eventId: editEventId || null } : {}),
        }),
      });
      if (!patchRes.ok) {
        const data = await patchRes.json().catch(() => null);
        setError(data?.error ?? "保存失败");
        return;
      }
      const errs: string[] = [];
      // schedule 绑定：换绑后重设（PATCH 已清旧绑定），或同事件下集合有变时重设
      if (editEventId) {
        const itemsChanged = eventChanged
          ? editScheduleItemIds.size > 0
          : editScheduleItemIds.size !== req.scheduleItemIds.length
            || req.scheduleItemIds.some(id => !editScheduleItemIds.has(id));
        if (itemsChanged) {
          const r = await fetch(`${base}/items`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemIds: [...editScheduleItemIds] }),
          });
          if (!r.ok) errs.push("日程条目绑定未保存");
        }
      }
      // 负责人：仅变更时提交（指派面独立——编辑权≠指派权，403 单独提示）
      const assigneesChanged =
        assignees.length !== req.assignees.length
        || assignees.some(a => !req.assignees.some(b => b.userId === a.userId));
      if (assigneesChanged) {
        const r = await fetch(`${base}/assignees`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignees }),
        });
        if (!r.ok) errs.push("负责人未保存（需要指派权限：部门 POC 或任务指派授权）");
      }
      const phasesChanged =
        editPhaseIds.size !== req.phaseIds.length
        || req.phaseIds.some(id => !editPhaseIds.has(id));
      if (phasesChanged) {
        const r = await fetch(`${base}/phases`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phaseIds: [...editPhaseIds] }),
        });
        if (!r.ok) errs.push("阶段未保存");
      }
      const blockedChanged =
        editBlockedByIds.size !== blockedBy.length
        || blockedBy.some(d => !editBlockedByIds.has(d.id));
      if (blockedChanged) {
        const r = await fetch(`${base}/blocked-by`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskIds: [...editBlockedByIds] }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => null);
          errs.push(data?.error ? `依赖未保存：${data.error}` : "依赖未保存");
        }
      }
      if (errs.length) { setError(errs.join("；")); return; }
      setEditMode(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const searchParams = useSearchParams();
  const notifId = searchParams.get("notif");
  const notifActed = useRef(false);

  function actNotif() {
    if (!notifId || notifActed.current) return;
    notifActed.current = true;
    fetch(`${BASE_PATH}/api/my/notifications/${notifId}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: "external" }),
    }).catch(() => {});
  }

  // Auto-act on mount if req is already not awaiting (case B: someone else confirmed it).
  useEffect(() => {
    if (notifId && initialReq.status !== "awaiting") actNotif();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const singleDay = isSingleDay(event);
  const linkedItems = scheduleItems
    .filter(it => req.scheduleItemIds.includes(it.id))
    .sort((a, b) => {
      if (!a.startTime && !b.startTime) return a.orderIndex - b.orderIndex;
      if (!a.startTime) return 1;
      if (!b.startTime) return -1;
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    });
  const canEdit = req.status === "awaiting" && isPocOfDept;
  const canChangeStatus = isPocOfDept || isAssignee || canViewFull;
  const isBlocked = blockedBy.some(d => d.status !== "done") && req.status !== "done";

  function toggleAssignee(person: { userId: string; name: string }) {
    setAssignees(prev =>
      prev.some(a => a.userId === person.userId)
        ? prev.filter(a => a.userId !== person.userId)
        : [...prev, person]
    );
  }

  // ── 负责人 picker（部门分组下拉，与新建表单同款；替代 chips 池）──────────────
  const peopleNameOf = new Map([...deptPeople, ...(allPeople ?? [])].map(p => [p.userId, p.name]));
  const assigneeItems = (() => {
    const items: { id: string; value?: string; label: string; parentId?: string | null; header?: boolean }[] = [];
    if (deptPeople.length > 0) {
      items.push({ id: "g:dept", label: deptName ? `${deptName}（本部门）` : "本部门", header: true });
      for (const p of deptPeople) items.push({ id: `g:dept:${p.userId}`, value: p.userId, parentId: "g:dept", label: p.name });
    }
    const deptIds = new Set(deptPeople.map(p => p.userId));
    const others = (allPeople ?? []).filter(p => !deptIds.has(p.userId));
    if (others.length > 0) {
      items.push({ id: "g:all", label: "其他成员", header: true });
      for (const p of others) items.push({ id: `g:all:${p.userId}`, value: p.userId, parentId: "g:all", label: p.name });
    }
    return items;
  })();

  function assigneePickerBlock(label: string) {
    if (assigneeItems.length === 0) return null;
    return (
      <div>
        <span style={FIELD_LABEL}>{label}</span>
        {assignees.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {assignees.map(a => (
              <span key={a.userId} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                borderRadius: 999, padding: "4px 11px", fontSize: 11, fontWeight: 600,
                background: "var(--ink)", color: "#fff",
              }}>
                {a.name}
                <button
                  type="button"
                  aria-label={`移除 ${a.name}`}
                  onClick={() => toggleAssignee(a)}
                  style={{ border: 0, background: "transparent", color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <DropdownPicker
          multi
          items={assigneeItems}
          values={new Set(assignees.map(a => a.userId))}
          placeholder="选择负责人"
          multiCountLabel={n => `已选 ${n} 人`}
          searchPlaceholder="搜索成员…"
          onChange={() => {}}
          onToggle={userId => toggleAssignee({ userId, name: peopleNameOf.get(userId) ?? "" })}
        />
      </div>
    );
  }

  const base = `${BASE_PATH}/api/production/${productionId}/tasks/${req.id}`;

  async function confirm(newStatus: string) {
    if (!title.trim()) { setError("请填写任务名称"); return; }
    setSaving(true);
    setError(null);
    try {
      await Promise.all([
        fetch(base, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), description }),
        }),
        fetch(`${base}/assignees`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignees }),
        }),
      ]);
      const res = await fetch(`${base}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) { setError("状态更新失败"); return; }
      setReq(r => ({ ...r, title: title.trim(), description, assignees, status: newStatus }));
      actNotif();
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(newStatus: string) {
    if (newStatus === req.status) return;
    setSaving(true);
    try {
      const res = await fetch(`${base}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) setReq(r => ({ ...r, status: newStatus }));
    } finally {
      setSaving(false);
    }
  }

  // 有效时间展示（自身 → 绑定日程 → 事件；无自身时间标注继承来源）
  const timeRange = req.effectiveStartTime
    ? `${fmtDateTime(req.effectiveStartTime)}${req.effectiveEndTime ? ` — ${singleDay || (req.effectiveStartTime.slice(0, 10) === req.effectiveEndTime.slice(0, 10)) ? fmtTime(req.effectiveEndTime) : fmtDateTime(req.effectiveEndTime)}` : ""}`
    : null;
  const overdue = req.status !== "done" && req.effectiveEndTime && new Date(req.effectiveEndTime) < new Date();

  const displayTitle = req.title || "待填写任务名称…";

  function depRow(d: TaskDependencyRef, direction: "blockedBy" | "blocks") {
    const active = d.status !== "done";
    return (
      <Link
        key={d.id}
        href={`/production/${productionId}/tasks/${d.id}`}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          borderRadius: 8, padding: "7px 10px", textDecoration: "none",
          border: "1px solid var(--line)", background: "var(--paper)",
        }}
      >
        {direction === "blockedBy" && active && <span title="未完成的前置任务" style={{ fontSize: 11 }}>⛔</span>}
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.title || "（未命名任务）"}
        </span>
        <span style={{ flexShrink: 0, borderRadius: 5, padding: "2px 7px", fontSize: 9, fontWeight: 700, ...statusBadgeStyle(d.status) }}>
          {STATUS_LABELS[d.status] ?? d.status}
        </span>
      </Link>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--paper)", padding: "24px clamp(18px, 3vw, 52px) 60px" }}>
      {/* breadcrumb */}
      <nav aria-label="breadcrumb" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontSize: 11, color: "var(--muted)" }}>
        <Link href={`/production/${productionId}/tasks`} style={{ color: "var(--muted)", textDecoration: "none", fontWeight: 700 }}>
          任务
        </Link>
        <span style={{ fontSize: 9 }}>›</span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)" }}>
          任务详情：{displayTitle}
        </span>
      </nav>

      {/* 统一页头：eyebrow + serif 标题 + 徽章行 */}
      <PageHeader eyebrow="Task Detail" title={displayTitle} side="stage">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <span style={{ borderRadius: 6, padding: "3px 9px", fontSize: 11, fontWeight: 700, ...statusBadgeStyle(req.status) }}>
            {STATUS_LABELS[req.status] ?? req.status}
          </span>
          {isBlocked && (
            <span style={{ borderRadius: 6, padding: "3px 9px", fontSize: 11, fontWeight: 700, background: "var(--danger-soft)", color: "var(--danger)" }}>
              ⛔ 受阻
            </span>
          )}
          {deptName && <span style={CHIP}>{deptName}</span>}
          {!event && <span style={CHIP}>独立任务</span>}
        </div>
      </PageHeader>

      {/* 主栏（任务本体）+ 侧栏（关联） */}
      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* ── 主栏 ── */}
        <div style={{ flex: "1 1 460px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
          <section style={PANEL}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <p style={{ ...SECTION_KICKER, margin: 0, flex: 1 }}>任务信息</p>
              {/* 编辑按钮常驻：有权→inline 编辑；免审批区间→自确认；无权→申请 modal */}
              {!canEdit && !editMode && (
                <button
                  onClick={handleEditClick}
                  disabled={accessChecking}
                  style={{
                    borderRadius: 8, padding: "6px 14px", fontSize: 11, fontWeight: 700,
                    border: "1px solid var(--ink)", background: "transparent",
                    color: "var(--ink)", cursor: "pointer", opacity: accessChecking ? 0.5 : 1,
                  }}
                >
                  {accessChecking ? "…" : "编辑"}
                </button>
              )}
            </div>

            {/* 时间行（有效解析链） */}
            {timeRange && (
              <p style={{ margin: "0 0 12px", fontSize: 12, color: overdue ? "var(--danger)" : "var(--muted)", fontWeight: overdue ? 700 : 400 }}>
                {timeRange}
                {overdue && " · 已逾期"}
                {!req.startTime && (
                  <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 400 }}>
                    （继承自{req.scheduleItemIds.length > 0 ? "绑定日程" : "事件"}）
                  </span>
                )}
              </p>
            )}

            {canEdit ? (
              /* Awaiting + POC: 确认编辑流 */
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label>
                  <span style={FIELD_LABEL}>任务名称 *</span>
                  <input value={title} onChange={e => setTitle(e.target.value)} placeholder="任务名称" style={FIELD_INPUT} />
                </label>
                <label>
                  <span style={FIELD_LABEL}>详情</span>
                  <SmartTextarea
                    value={description}
                    onChange={setDescription}
                    contentMention={{ productionId }}
                    rows={4}
                    className={styles.fieldInput}
                    placeholder="任务详情（可选）"
                  />
                </label>
                {assigneePickerBlock("负责人")}
                {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{error}</p>}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>确认并标为：</span>
                  {STATUS_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => confirm(opt.value)}
                      disabled={saving}
                      style={{
                        borderRadius: 8, padding: "7px 13px", fontSize: 11, fontWeight: 700,
                        border: "1px solid transparent", cursor: "pointer",
                        opacity: saving ? 0.5 : 1, ...statusBadgeStyle(opt.value),
                      }}
                    >
                      {saving ? "…" : opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : editMode ? (
              /* inline 编辑态（编辑按钮进入；名称/详情/时间/负责人/里程碑/依赖一次保存） */
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label>
                  <span style={FIELD_LABEL}>任务名称 *</span>
                  <input value={title} onChange={e => setTitle(e.target.value)} placeholder="任务名称" style={FIELD_INPUT} />
                </label>
                <label>
                  <span style={FIELD_LABEL}>详情</span>
                  <SmartTextarea
                    value={description}
                    onChange={setDescription}
                    contentMention={{ productionId }}
                    rows={4}
                    className={styles.fieldInput}
                    placeholder="任务详情（可选）"
                  />
                </label>
                <div>
                  <span style={FIELD_LABEL}>起止时间（留空 = 继承绑定日程/事件）</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input type="datetime-local" value={editStartTime} onChange={e => setEditStartTime(e.target.value)} style={{ ...FIELD_INPUT, width: 200 }} />
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>—</span>
                    <input type="datetime-local" value={editEndTime} onChange={e => setEditEndTime(e.target.value)} style={{ ...FIELD_INPUT, width: 200 }} />
                    {(editStartTime || editEndTime) && (
                      <button
                        type="button"
                        onClick={() => { setEditStartTime(""); setEditEndTime(""); }}
                        style={{ border: "1px solid var(--line)", borderRadius: 8, background: "transparent", padding: "8px 10px", fontSize: 11, cursor: "pointer", color: "var(--muted)" }}
                      >
                        清除（恢复继承）
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <span style={FIELD_LABEL}>关联事件（仅列出你可挂载的；换绑会清空原日程条目绑定）</span>
                  {attachableEvents === null ? (
                    <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>加载可挂载事件…</p>
                  ) : (
                    <DropdownPicker
                      items={(() => {
                        const items = attachableEvents.map(ev => ({
                          id: ev.id,
                          label: `${ev.startTime ? `${new Date(ev.startTime).getMonth() + 1}/${new Date(ev.startTime).getDate()} · ` : ""}${ev.title}`,
                          sublabel: ev.requiresPocDept ? "POC 路径（需任务绑定你负责的部门）" : undefined,
                          disabled: ev.requiresPocDept && !isPocOfDept,
                        }));
                        // 当前绑定的事件不在可挂载列表时补一项（保持现绑定合法可见）
                        if (event && !attachableEvents.some(ev => ev.id === event.id)) {
                          items.unshift({ id: event.id, label: `${event.title}（当前绑定）`, sublabel: undefined, disabled: false });
                        }
                        return items;
                      })()}
                      value={editEventId || null}
                      placeholder="不关联（独立任务）"
                      clearLabel="不关联（独立任务）"
                      searchPlaceholder="搜索事件…"
                      onChange={id => setEditEventId(id ?? "")}
                    />
                  )}
                  {editEventId && editScheduleOptions.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <span style={{ ...FIELD_LABEL, marginBottom: 6 }}>绑定日程条目（不设时间时任务时间取条目区间）</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {editScheduleOptions.map(it => {
                          const active = editScheduleItemIds.has(it.id);
                          return (
                            <button
                              key={it.id}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setEditScheduleItemIds(prev => {
                                const next = new Set(prev);
                                if (next.has(it.id)) next.delete(it.id); else next.add(it.id);
                                return next;
                              })}
                              style={{
                                border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
                                borderRadius: 999, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                                background: active ? "var(--ink)" : "transparent",
                                color: active ? "#fff" : "var(--muted)",
                              }}
                            >
                              {it.title}
                              {it.startTime ? ` · ${fmtTime(it.startTime)}` : ""}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                {assigneePickerBlock("负责人（保存需指派权限：部门 POC 或任务指派授权）")}
                {phaseOptions.length > 0 && (
                  <div>
                    <span style={FIELD_LABEL}>阶段</span>
                    <DropdownPicker
                      multi
                      items={phaseOptions.map(p => ({
                        id: p.id,
                        label: p.deptName ? `${p.name}（${p.deptName}）` : p.name,
                        sublabel: `${p.startDate} ~ ${p.endDate ?? "未定"}`,
                      }))}
                      values={editPhaseIds}
                      placeholder="绑定阶段（可多选）"
                      multiCountLabel={n => `已绑定 ${n} 个阶段`}
                      searchPlaceholder="搜索阶段…"
                      onChange={() => {}}
                      onToggle={id => setEditPhaseIds(prev => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id); else next.add(id);
                        return next;
                      })}
                    />
                  </div>
                )}
                {taskOptions.length > 0 && (
                  <div>
                    <span style={FIELD_LABEL}>前置依赖（被哪些任务挡住；成环会被拒绝）</span>
                    <DropdownPicker
                      multi
                      items={taskOptions.map(t => ({
                        id: t.id,
                        label: t.title || "（未命名任务）",
                        sublabel: STATUS_LABELS[t.status] ?? t.status,
                      }))}
                      values={editBlockedByIds}
                      placeholder="选择挡住本任务的前置任务"
                      multiCountLabel={n => `${n} 个前置任务`}
                      searchPlaceholder="搜索任务…"
                      onChange={() => {}}
                      onToggle={id => setEditBlockedByIds(prev => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id); else next.add(id);
                        return next;
                      })}
                    />
                  </div>
                )}
                {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{error}</p>}
                <div style={{ display: "flex", gap: 8, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                  <button onClick={saveEdit} disabled={saving} style={{ ...PRIMARY_BTN, opacity: saving ? 0.5 : 1 }}>
                    {saving ? "保存中…" : "保存"}
                  </button>
                  <button onClick={() => { setEditMode(false); setError(null); }} disabled={saving} style={SECONDARY_BTN}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              /* 只读 + 状态推进 */
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {req.description ? (
                  <SmartText content={req.description} plugins={[scriptRefTextPlugin]} productionId={productionId} />
                ) : (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>（无详情）</p>
                )}
                <div>
                  <span style={FIELD_LABEL}>负责人</span>
                  {req.assignees.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {req.assignees.map(a => <span key={a.userId} style={CHIP}>{a.name}</span>)}
                    </div>
                  ) : (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
                      未指派{deptName ? `——待 ${deptName} POC 分配` : ""}
                    </p>
                  )}
                </div>
                {canChangeStatus && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>状态：</span>
                    {STATUS_OPTIONS.map(opt => {
                      const active = req.status === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => changeStatus(opt.value)}
                          disabled={saving || active}
                          style={{
                            borderRadius: 8, padding: "7px 13px", fontSize: 11, fontWeight: 700,
                            cursor: active ? "default" : "pointer",
                            border: "1px solid " + (active ? "currentColor" : "var(--line)"),
                            opacity: saving ? 0.5 : 1,
                            ...(active ? statusBadgeStyle(opt.value) : { background: "transparent", color: "var(--muted)" }),
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 依赖（有数据才显示；blocked-by 编辑面后续刀） */}
          {(blockedBy.length > 0 || blocks.length > 0) && (
            <section style={PANEL}>
              <p style={SECTION_KICKER}>任务依赖</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {blockedBy.length > 0 && (
                  <div>
                    <span style={FIELD_LABEL}>被这些任务挡住（blocked by）</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {blockedBy.map(d => depRow(d, "blockedBy"))}
                    </div>
                  </div>
                )}
                {blocks.length > 0 && (
                  <div>
                    <span style={FIELD_LABEL}>挡住了这些任务（blocking）</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {blocks.map(d => depRow(d, "blocks"))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        {/* ── 侧栏：关联 ── */}
        <div style={{ flex: "0 1 340px", minWidth: 280, display: "flex", flexDirection: "column", gap: 18 }}>
          <section style={PANEL}>
            <p style={SECTION_KICKER}>关联</p>

            {/* 事件卡（task-first：事件退为关联对象） */}
            {event ? (
              <Link
                href={`/production/${productionId}/events/${event.id}`}
                style={{
                  display: "block", borderRadius: 10, padding: "12px 14px", marginBottom: 12,
                  border: "1px solid var(--line)", background: "var(--paper)", textDecoration: "none",
                }}
              >
                <span style={{ display: "block", fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--stage)" }}>
                  关联事件
                </span>
                <span style={{ display: "block", marginTop: 4, fontFamily: PAGE_TITLE_FONT, fontSize: 15, color: "var(--ink)" }}>
                  {event.title}
                </span>
                <span style={{ display: "block", marginTop: 3, fontSize: 11, color: "var(--muted)" }}>
                  {[
                    event.startTime ? fmtDateTime(event.startTime) : null,
                    event.location || null,
                  ].filter(Boolean).join(" · ") || "时间地点待定"}
                </span>
              </Link>
            ) : (
              <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)" }}>
                独立任务，未绑定事件。
              </p>
            )}

            {/* 绑定的日程条目（只列绑定的；完整流程去事件日程页） */}
            {linkedItems.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <span style={FIELD_LABEL}>绑定日程条目</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {linkedItems.map(item => (
                    <div key={item.id} style={{ borderRadius: 8, padding: "8px 11px", border: "1px solid var(--line)", background: "var(--paper)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{item.title}</span>
                        <span style={{ fontSize: 9, color: "var(--muted)", background: "var(--surface-2)", borderRadius: 4, padding: "1px 6px" }}>
                          {SCHEDULE_ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}
                        </span>
                      </div>
                      {(item.startTime || item.location) && (
                        <p style={{ margin: "3px 0 0", fontSize: 10.5, color: "var(--muted)" }}>
                          {[item.startTime ? fmtItemTime(item, singleDay) : null, item.location || null].filter(Boolean).join(" · ")}
                        </p>
                      )}
                      {item.notes && (
                        <div style={{ margin: "3px 0 0", fontSize: 10.5, color: "var(--muted)" }}>
                          <SmartText content={item.notes} plugins={[scriptRefTextPlugin]} productionId={productionId} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {event && (
              <Link
                href={`/production/${productionId}/events/${event.id}/view`}
                style={{ display: "inline-block", marginBottom: 12, fontSize: 11, fontWeight: 700, color: "var(--stage)", textDecoration: "none" }}
              >
                查看完整日程 →
              </Link>
            )}

            {/* 阶段 */}
            {phases.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <span style={FIELD_LABEL}>阶段</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {phases.map(p => (
                    <span key={p.id} title={`${p.startDate} ~ ${p.endDate ?? "未定"}`} style={CHIP}>
                      {p.deptName ? `${p.name}（${p.deptName}）` : p.name}
                      {" · "}
                      {p.startDate.slice(5).replace("-", "/")}–{p.endDate ? p.endDate.slice(5).replace("-", "/") : "未定"}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 飞书群（event 语境） */}
            {event && (isPocOfDept || canViewFull) && (
              <div>
                <span style={FIELD_LABEL}>飞书群</span>
                <ReqChatSection
                  req={req} event={event} productionId={productionId}
                  canManage={isPocOfDept || canViewFull}
                  onChatIdSet={chatId => setReq(r => ({ ...r, chatId }))}
                />
              </div>
            )}
          </section>

          {/* 返回入口（次按钮语汇） */}
          <div style={{ display: "flex", gap: 8 }}>
            <Link href={`/production/${productionId}/tasks`} style={{ ...SECONDARY_BTN, textDecoration: "none", display: "inline-block" }}>
              ← 返回任务面板
            </Link>
            {event && (
              <Link href={`/production/${productionId}/tasks?event=${event.id}`} style={{ ...SECONDARY_BTN, textDecoration: "none", display: "inline-block" }}>
                同事件任务
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* 免审批区间自确认（三态中间态） */}
      {selfConfirmLevel && (
        <div
          role="presentation"
          onMouseDown={() => setSelfConfirmLevel(null)}
          style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(18,28,27,.5)", display: "grid", placeItems: "center", padding: 20 }}
        >
          <section
            role="dialog"
            aria-modal="true"
            onMouseDown={e => e.stopPropagation()}
            style={{ width: "min(420px, 100%)", background: "var(--surface)", borderRadius: 13, padding: 22 }}
          >
            <p style={{ margin: 0, fontSize: 9, letterSpacing: ".13em", textTransform: "uppercase", color: "var(--muted)" }}>SELF CONFIRM</p>
            <h2 style={{ margin: "6px 0 10px", fontFamily: PAGE_TITLE_FONT, fontSize: 19, fontWeight: 500, color: "var(--ink)" }}>
              确认编辑此任务
            </h2>
            <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
              你在此任务的免审批区间内——确认后将获得{selfConfirmLevel === "manage" ? "管理" : "编辑"}权限并进入编辑，此操作会被记录。
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={SECONDARY_BTN} onClick={() => setSelfConfirmLevel(null)}>取消</button>
              <button style={{ ...PRIMARY_BTN, opacity: selfConfirming ? 0.5 : 1 }} disabled={selfConfirming} onClick={selfConfirmAndEdit}>
                {selfConfirming ? "确认中…" : "确认并编辑"}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* 无权限 → 固定款申请 modal（锁定到本任务 edit 面） */}
      <AccessRequestModal
        open={requestModalOpen}
        onClose={() => setRequestModalOpen(false)}
        productionId={productionId}
        permission={`node:task/${req.id}/*@edit`}
      />
    </div>
  );
}
