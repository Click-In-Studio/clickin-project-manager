"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ProductionTechReqEntry } from "@/lib/event-db";
import { BASE_PATH } from "@/lib/base-path";
import { datetimeLocalToIso, fmtDate, fmtTime, isoToDatetimeLocal } from "@/lib/tz";
import SmartText, { scriptRefTextPlugin } from "@/components/SmartText";
import type { PickerMember, PickerDept } from "@/components/MemberPickerModal";
import DropdownPicker, { type DropdownPickerItem } from "@/components/DropdownPicker";
import styles from "@/components/my-pages.module.css";

const STATUS_LABEL: Record<string, string> = {
  awaiting: "待确认",
  pending: "待处理",
  in_progress: "进行中",
  done: "完成",
};

/** 状态徽章：主题色板（原型 notes 紫 / warn / script 青 / success 绿） */
function statusBadgeStyle(status: string): React.CSSProperties {
  if (status === "awaiting") return { background: "#eee5f0", color: "#7a5a86" };
  if (status === "pending") return { background: "var(--warn-soft)", color: "var(--warn)" };
  if (status === "in_progress") return { background: "var(--script-soft)", color: "var(--script)" };
  if (status === "done") return { background: "var(--success-soft)", color: "var(--success)" };
  return { background: "var(--paper)", color: "var(--muted)" };
}

/** 截止展示：有效结束时间（自身→绑定日程→事件解析链）；过期红、今日警示 */
function dueInfo(t: ProductionTechReqEntry): { label: string; style: React.CSSProperties } | null {
  const iso = t.effectiveEndTime;
  if (!iso) return null;
  const d = new Date(iso);
  const label = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (t.status === "done") return { label, style: { color: "var(--muted)" } };
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (d.getTime() < now.getTime() && !sameDay)
    return { label: `${label} 已逾期`, style: { color: "var(--danger)", fontWeight: 700 } };
  if (sameDay)
    return { label: `${label} 今日截止`, style: { color: "var(--warn)", fontWeight: 700 } };
  return { label, style: { color: "var(--muted)" } };
}

const isBlockedActive = (t: ProductionTechReqEntry) => t.isBlocked && t.status !== "done";

function BlockedChip() {
  return (
    <span style={{
      flexShrink: 0, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700,
      background: "var(--danger-soft)", color: "var(--danger)",
    }}>
      ⛔ 受阻
    </span>
  );
}

/** 关系行文案：关联事件 / 独立任务（event 绑定可选后 eventTitle 可空） */
function relationLabel(t: ProductionTechReqEntry): string {
  const base = t.eventTitle ?? "独立任务";
  return t.departmentName ? `${base} · ${t.departmentName}` : base;
}

type StatusFilter = "active" | "awaiting" | "pending" | "in_progress" | "done";

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  active: "进行中任务",
  awaiting: "待确认",
  pending: "待处理",
  in_progress: "进行中",
  done: "已完成",
};

const VALID_STATUSES = ["awaiting", "pending", "in_progress", "done"] as const;

// 时间一律 CST，不跟浏览器时区走（全库口径见 lib/tz.ts）。原实现用
// getTimezoneOffset 转成浏览器本地时间填进 datetime-local，非 CST 用户看到的
// 是偏移过的时刻，改完保存又按本地时区解析写回去，读写两头都歪。

// ─── 新建任务模态框 ───────────────────────────────────────────────────────────

type CreateOptions = {
  pocDepts: { id: string; name: string; parentId: string | null }[];
  /** 可指派人员池：assignees@edit 通配 ⇒ 全员；否则 ⇒ 我 POC 部门的成员并集 */
  members: PickerMember[];
  depts: PickerDept[];
  canAssignAnyone: boolean;
  milestones: { id: string; name: string; endDate: string }[];
  events: { id: string; title: string; startTime: string | null; requiresPocDept: boolean }[];
  /** 用户组也是 task 的责任主体（部门 | 用户组，二选一） */
  userGroups: { id: string; name: string }[];
  canCreateStandalone: boolean;
};

/**
 * 抽屉里的「责任方」是**一个**下拉，值域是部门 ∪ 用户组，用前缀区分。
 * task 的责任主体必须唯一（POC 从它推），所以不能做成两个各自可选的字段。
 */
type SubjectValue = `dept:${string}` | `group:${string}` | "";

function subjectValueOf(task: { departmentId: string | null; groupId: string | null }): SubjectValue {
  if (task.departmentId) return `dept:${task.departmentId}`;
  if (task.groupId) return `group:${task.groupId}`;
  return "";
}

/** 下拉值 → PATCH body 的主体字段。空 = 清空主体（两支都置 null）。 */
function subjectBody(v: SubjectValue): { departmentId: string | null; groupId: string | null } {
  if (v.startsWith("dept:")) return { departmentId: v.slice(5), groupId: null };
  if (v.startsWith("group:")) return { departmentId: null, groupId: v.slice(6) };
  return { departmentId: null, groupId: null };
}

const FIELD_LABEL: React.CSSProperties = {
  display: "block", marginBottom: 5, fontSize: 10, fontWeight: 700,
  letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)",
};
const FIELD_INPUT: React.CSSProperties = {
  width: "100%", border: "1px solid var(--line)", borderRadius: 8,
  padding: "9px 12px", fontSize: 12, color: "var(--ink)",
  background: "var(--paper)", outline: "none",
};
/** 参与人下拉行：部门树分组（header 行 + 成员挂组；多部门成员在各组出现，
 *  行 id 合成唯一、value=userId 共享勾选态；无部门成员进"未分配"组） */
function memberDropdownItems(options: CreateOptions): DropdownPickerItem[] {
  const memberOf = new Map(options.members.map(m => [m.userId, m]));
  const items: DropdownPickerItem[] = [];
  const grouped = new Set<string>();
  const deptIds = new Set(options.depts.map(d => d.id));
  const row = (m: PickerMember, rowId: string, parentId: string): DropdownPickerItem => ({
    id: rowId,
    value: m.userId,
    parentId,
    label: m.name || "（未命名）",
    sublabel: [m.roles.join(" · "), m.email ?? ""].filter(Boolean).join("  ") || undefined,
  });
  for (const d of options.depts) {
    const ms = d.memberUserIds.map(id => memberOf.get(id)).filter((m): m is PickerMember => !!m);
    if (ms.length === 0) continue;
    items.push({
      id: `d:${d.id}`,
      label: d.name,
      header: true,
      parentId: d.parentId && deptIds.has(d.parentId) ? `d:${d.parentId}` : null,
    });
    for (const m of ms) {
      items.push(row(m, `d:${d.id}:${m.userId}`, `d:${d.id}`));
      grouped.add(m.userId);
    }
  }
  const unassigned = options.members.filter(m => !grouped.has(m.userId));
  if (unassigned.length > 0) {
    items.push({ id: "d:__none", label: "未分配部门", header: true, parentId: null });
    for (const m of unassigned) items.push(row(m, `d:__none:${m.userId}`, "d:__none"));
  }
  return items;
}

const CHIP_TOGGLE = (active: boolean): React.CSSProperties => ({
  border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
  borderRadius: 999, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
  background: active ? "var(--ink)" : "transparent",
  color: active ? "#fff" : "var(--muted)",
});

function CreateTaskModal({ productionId, onClose, onCreated }: {
  productionId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [options, setOptions] = useState<CreateOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deptId, setDeptId] = useState("");
  const [assignees, setAssignees] = useState<Map<string, string>>(new Map());
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [milestoneIds, setMilestoneIds] = useState<Set<string>>(new Set());
  const [eventId, setEventId] = useState("");
  const [scheduleItems, setScheduleItems] = useState<{ id: string; title: string; startTime: string | null }[]>([]);
  const [scheduleItemIds, setScheduleItemIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE_PATH}/api/production/${productionId}/tasks/create-options`)
      .then(r => r.json())
      .then((j: CreateOptions & { error?: string }) => {
        if (cancelled) return;
        if (j.error) setLoadError(j.error);
        else setOptions(j);
      })
      .catch(() => { if (!cancelled) setLoadError("加载失败"); });
    return () => { cancelled = true; };
  }, [productionId]);

  // 选择事件后拉取其 schedule 条目；换事件清空已选条目
  useEffect(() => {
    setScheduleItemIds(new Set());
    if (!eventId) { setScheduleItems([]); return; }
    let cancelled = false;
    fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule`)
      .then(r => r.json())
      .then((j: { items?: { id: string; title: string; startTime: string | null }[] }) => {
        if (!cancelled) setScheduleItems(j.items ?? []);
      })
      .catch(() => { if (!cancelled) setScheduleItems([]); });
    return () => { cancelled = true; };
  }, [productionId, eventId]);

  const selectedEvent = options?.events.find(e => e.id === eventId) ?? null;
  // 可挂载性：requiresPocDept 的事件必须同时绑定本人 POC 的部门（POC 路径三）
  const eventNeedsDept = selectedEvent?.requiresPocDept && !deptId;
  const nothingCreatable = options && !options.canCreateStandalone && options.events.length === 0;

  async function submit() {
    if (!options) return;
    const t = title.trim();
    if (!t) { setError("请填写任务名称"); return; }
    if (!eventId && !options.canCreateStandalone) { setError("你没有创建独立任务的权限，请选择关联事件"); return; }
    if (eventNeedsDept) { setError("该事件仅可通过部门 POC 路径挂载，请选择你负责的部门"); return; }
    if (startTime && endTime && new Date(endTime) < new Date(startTime)) { setError("结束时间不能早于开始时间"); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t,
          description,
          departmentId: deptId || null,
          assignees: [...assignees.entries()].map(([userId, name]) => ({ userId, name })),
          startTime: startTime ? datetimeLocalToIso(startTime) : null,
          endTime: endTime ? datetimeLocalToIso(endTime) : null,
          milestoneIds: [...milestoneIds],
          eventId: eventId || null,
          scheduleItemIds: [...scheduleItemIds],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error ?? "创建失败"); return; }
      onCreated();
    } catch {
      setError("网络错误，创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="presentation"
      onMouseDown={onClose}
      style={{ position: "fixed", zIndex: 80, inset: 0, background: "rgba(18,28,27,.65)", display: "grid", placeItems: "center", padding: 20 }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-task-title"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: "min(680px, 100%)", maxHeight: "calc(100vh - 40px)", overflowY: "auto", background: "var(--surface)", borderRadius: 15, boxShadow: "0 24px 80px rgba(0,0,0,.3)" }}
      >
        {/* modalHeader（原型规格） */}
        <div style={{ padding: "22px 25px 15px", display: "flex", gap: 18 }}>
          <div>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 9, letterSpacing: ".13em" }}>CREATE TASK</p>
            <h2 id="create-task-title" style={{ margin: "6px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 24, fontWeight: 500, color: "var(--ink)" }}>
              新建任务
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{ marginLeft: "auto", width: 31, height: 31, border: "1px solid var(--line)", background: "transparent", borderRadius: "50%", fontSize: 20, cursor: "pointer", color: "var(--muted)" }}
          >
            ×
          </button>
        </div>
        <p style={{ margin: 0, padding: "0 25px 15px", color: "var(--muted)", fontSize: 11, lineHeight: 1.6 }}>
          任务可独立存在，也可关联事件、日程条目或里程碑；不设时间时将继承绑定日程/事件的起止。
        </p>

        {!options && !loadError && (
          <p style={{ padding: "24px 25px", margin: 0, fontSize: 12, color: "var(--muted)" }}>加载中…</p>
        )}
        {loadError && (
          <p style={{ padding: "24px 25px", margin: 0, fontSize: 12, color: "var(--danger)" }}>{loadError}</p>
        )}
        {nothingCreatable && (
          <p style={{ padding: "0 25px 24px", margin: 0, fontSize: 12, color: "var(--danger)" }}>
            你目前没有创建任务的权限（需要独立任务创建资格，或对某个事件有任务挂载资格）。
          </p>
        )}

        {options && !nothingCreatable && (
          <div style={{ padding: "0 25px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
            <label>
              <span style={FIELD_LABEL}>任务名称 *</span>
              <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="要做什么" style={FIELD_INPUT} />
            </label>
            <label>
              <span style={FIELD_LABEL}>简介</span>
              <textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="补充背景、验收标准或注意事项" style={{ ...FIELD_INPUT, resize: "vertical" }} />
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label>
                <span style={FIELD_LABEL}>开始时间</span>
                <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)} style={FIELD_INPUT} />
              </label>
              <label>
                <span style={FIELD_LABEL}>结束 / 截止时间</span>
                <input type="datetime-local" value={endTime} onChange={e => setEndTime(e.target.value)} style={FIELD_INPUT} />
              </label>
            </div>

            {options.pocDepts.length > 0 && (
              <div>
                <span style={FIELD_LABEL}>部门（仅限你担任 POC 的部门）</span>
                <DropdownPicker
                  items={options.pocDepts.map(d => ({ id: d.id, label: d.name, parentId: d.parentId }))}
                  value={deptId || null}
                  placeholder="不绑定部门"
                  clearLabel="不绑定部门"
                  searchPlaceholder="搜索部门…"
                  onChange={id => setDeptId(id ?? "")}
                />
              </div>
            )}

            <div>
              <span style={FIELD_LABEL}>
                参与人{options.canAssignAnyone ? "" : "（限你担任 POC 的部门成员）"}
              </span>
              {assignees.size > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  {[...assignees.entries()].map(([userId, name]) => (
                    <span key={userId} style={{ ...CHIP_TOGGLE(true), display: "inline-flex", alignItems: "center", gap: 6, cursor: "default" }}>
                      {name}
                      <button
                        type="button"
                        aria-label={`移除 ${name}`}
                        onClick={() => setAssignees(prev => { const next = new Map(prev); next.delete(userId); return next; })}
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
                items={memberDropdownItems(options)}
                values={new Set(assignees.keys())}
                placeholder={options.members.length === 0 ? "无可指派成员" : "选择参与人"}
                searchPlaceholder="搜索姓名 / 角色 / 联系方式…"
                disabled={options.members.length === 0}
                onChange={() => {}}
                onToggle={userId => {
                  const name = options.members.find(m => m.userId === userId)?.name ?? "";
                  setAssignees(prev => {
                    const next = new Map(prev);
                    if (next.has(userId)) next.delete(userId); else next.set(userId, name);
                    return next;
                  });
                }}
              />
            </div>

            {options.milestones.length > 0 && (
              <div>
                <span style={FIELD_LABEL}>里程碑（可多选，不约束截止先后）</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {options.milestones.map(m => {
                    const active = milestoneIds.has(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setMilestoneIds(prev => {
                          const next = new Set(prev);
                          if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                          return next;
                        })}
                        style={CHIP_TOGGLE(active)}
                      >
                        ◆ {m.name} · {m.endDate.slice(5, 10).replace("-", "/")}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <span style={FIELD_LABEL}>关联事件（仅列出你可挂载的）</span>
              <DropdownPicker
                items={options.events.map(ev => ({
                  id: ev.id,
                  label: `${ev.startTime ? `${fmtDate(ev.startTime)} · ` : ""}${ev.title}`,
                  sublabel: ev.requiresPocDept ? "需绑定你负责的部门（POC 路径）" : undefined,
                }))}
                value={eventId || null}
                placeholder={options.canCreateStandalone ? "不关联（独立任务）" : "请选择事件"}
                clearLabel={options.canCreateStandalone ? "不关联（独立任务）" : undefined}
                searchPlaceholder="搜索事件…"
                onChange={id => setEventId(id ?? "")}
              />
              {eventNeedsDept && (
                <small style={{ display: "block", marginTop: 5, fontSize: 10, color: "var(--warn)" }}>
                  该事件仅可通过部门 POC 路径挂载——请在上方选择你负责的部门
                </small>
              )}
            </div>

            {eventId && scheduleItems.length > 0 && (
              <div>
                <span style={FIELD_LABEL}>绑定日程条目（可多选；不设时间时任务时间取条目区间）</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {scheduleItems.map(it => {
                    const active = scheduleItemIds.has(it.id);
                    return (
                      <button
                        key={it.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setScheduleItemIds(prev => {
                          const next = new Set(prev);
                          if (next.has(it.id)) next.delete(it.id); else next.add(it.id);
                          return next;
                        })}
                        style={CHIP_TOGGLE(active)}
                      >
                        {it.title}
                        {it.startTime ? ` · ${fmtTime(it.startTime)}` : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{error}</p>}
          </div>
        )}

        {/* modalFooter（原型规格） */}
        <div style={{ borderTop: "1px solid var(--line)", padding: "15px 25px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onClose}
            style={{ borderRadius: 8, padding: "10px 14px", border: "1px solid var(--ink)", cursor: "pointer", fontSize: 12, fontWeight: 700, background: "transparent", color: "var(--ink)" }}
          >
            取消
          </button>
          <button
            disabled={submitting || !options || !!nothingCreatable}
            onClick={submit}
            style={{
              borderRadius: 8, padding: "10px 14px", border: "1px solid var(--ink)", cursor: "pointer",
              fontSize: 12, fontWeight: 700, background: "var(--ink)", color: "#fff",
              opacity: submitting || !options || nothingCreatable ? 0.5 : 1,
            }}
          >
            {submitting ? "创建中…" : "创建任务"}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function ProductionTasksClient({
  productionId,
  initialTasks,
  initialEventFilter,
  currentUserId,
}: {
  productionId: string;
  initialTasks: ProductionTechReqEntry[];
  /** 事件页关联徽章链跳入时的初始筛选（?event=） */
  initialEventFilter?: string;
  /** "我的"scope 判定（assignee 含本人） */
  currentUserId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tasks, setTasks] = useState(initialTasks);
  // router.refresh() 后服务端重投喂（新建任务落库）→ 本地列表跟进
  useEffect(() => { setTasks(initialTasks); }, [initialTasks]);
  const [createOpen, setCreateOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(() => new Set());
  const completionTimers = useRef<Map<string, number>>(new Map());
  useEffect(() => () => {
    completionTimers.current.forEach(timer => window.clearTimeout(timer));
    completionTimers.current.clear();
  }, []);
  // 筛选态初始化自 URL query（详情页 ↗ 跳走返回 / 分享链接不丢上下文）
  // 三 scope（原型）：我的 / 全部 / 按事件（仅看关联了事件的 Task）。
  const [scope, setScope] = useState<"mine" | "all" | "event">(() => {
    const s = searchParams.get("scope");
    return s === "mine" || s === "event" ? s : "all";
  });
  const [selectedEvent, setSelectedEvent] = useState<string>(() => {
    const fromQuery = initialEventFilter ?? searchParams.get("event");
    if (fromQuery === "__standalone") return "__standalone";
    return fromQuery && initialTasks.some(t => t.eventId === fromQuery) ? fromQuery : "all";
  });
  const [selectedDept, setSelectedDept] = useState<string>(() => {
    const d = searchParams.get("dept");
    return d && initialTasks.some(t => t.departmentId === d) ? d : "all";
  });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    const s = searchParams.get("status");
    return s && ["awaiting", "pending", "in_progress", "done"].includes(s) ? (s as StatusFilter) : "active";
  });
  // 抽屉态：selected 非空 = 抽屉开（点击行开/切换，点外部/Esc/×/再点同行关）
  const [selected, setSelected] = useState<ProductionTechReqEntry | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const [drawerEditing, setDrawerEditing] = useState(false);
  const [drawerTitle, setDrawerTitle] = useState("");
  const [drawerDescription, setDrawerDescription] = useState("");
  const [drawerStart, setDrawerStart] = useState("");
  const [drawerEnd, setDrawerEnd] = useState("");
  const [drawerEventId, setDrawerEventId] = useState("");
  const [drawerSubject, setDrawerSubject] = useState<SubjectValue>("");
  const [drawerOptions, setDrawerOptions] = useState<CreateOptions | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  useEffect(() => {
    setDrawerEditing(false);
    setDrawerError(null);
  }, [selected?.id]);

  // 筛选态回写 URL（replaceState，不触发导航）
  useEffect(() => {
    const q = new URLSearchParams();
    if (scope !== "all") q.set("scope", scope);
    if (selectedEvent !== "all") q.set("event", selectedEvent);
    if (selectedDept !== "all") q.set("dept", selectedDept);
    if (statusFilter !== "active") q.set("status", statusFilter);
    const qs = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [scope, selectedEvent, selectedDept, statusFilter]);

  // 抽屉：Esc / 点外部关闭（行按钮自身的开/关切换由行 onClick 处理）
  useEffect(() => {
    if (!selected) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    const outside = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (drawerRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-task-row]")) return;
      setSelected(null);
    };
    document.addEventListener("keydown", esc);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", esc);
      document.removeEventListener("pointerdown", outside);
    };
  }, [selected]);

  async function updateStatus(task: ProductionTechReqEntry, newStatus: string) {
    setUpdating(true);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/tasks/${task.id}/status`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: newStatus }) }
      );
      if (!res.ok) return;
      const patch = { ...task, status: newStatus };
      setTasks(prev => prev.map(t => t.id === task.id ? patch : t));
      setSelected(prev => prev?.id === task.id ? patch : prev);
      const previousTimer = completionTimers.current.get(task.id);
      if (previousTimer) window.clearTimeout(previousTimer);
      if (newStatus === "done") {
        setCompletingIds(current => new Set(current).add(task.id));
        const timer = window.setTimeout(() => {
          setCompletingIds(current => {
            const next = new Set(current);
            next.delete(task.id);
            return next;
          });
          setSelected(current => current?.id === task.id ? null : current);
          completionTimers.current.delete(task.id);
        }, 1600);
        completionTimers.current.set(task.id, timer);
      } else {
        completionTimers.current.delete(task.id);
        setCompletingIds(current => {
          const next = new Set(current);
          next.delete(task.id);
          return next;
        });
      }
    } finally {
      setUpdating(false);
    }
  }

  function beginDrawerEdit(task: ProductionTechReqEntry) {
    setDrawerTitle(task.title);
    setDrawerDescription(task.description);
    setDrawerStart(isoToDatetimeLocal(task.startTime));
    setDrawerEnd(isoToDatetimeLocal(task.endTime));
    setDrawerEventId(task.eventId ?? "");
    setDrawerSubject(subjectValueOf(task));
    setDrawerError(null);
    setDrawerEditing(true);
    if (!drawerOptions) {
      fetch(`${BASE_PATH}/api/production/${productionId}/tasks/create-options`)
        .then(r => r.json())
        .then((data: CreateOptions) => setDrawerOptions(data))
        .catch(() => setDrawerError("无法加载事件和部门选项"));
    }
  }

  async function saveDrawerEdit(task: ProductionTechReqEntry) {
    if (!drawerTitle.trim()) { setDrawerError("任务名称不能为空"); return; }
    if (drawerStart && drawerEnd && new Date(drawerEnd) <= new Date(drawerStart)) { setDrawerError("结束时间必须晚于开始时间"); return; }
    setUpdating(true);
    setDrawerError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: drawerTitle.trim(),
          description: drawerDescription,
          startTime: drawerStart ? datetimeLocalToIso(drawerStart) : null,
          endTime: drawerEnd ? datetimeLocalToIso(drawerEnd) : null,
          eventId: drawerEventId || null,
          ...subjectBody(drawerSubject),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setDrawerError(data.error ?? "保存失败"); return; }
      const eventTitle = drawerOptions?.events.find(event => event.id === drawerEventId)?.title ?? null;
      const sub = subjectBody(drawerSubject);
      const departmentName = sub.departmentId
        ? drawerOptions?.depts.find(dept => dept.id === sub.departmentId)?.name ?? null : null;
      const groupName = sub.groupId
        ? drawerOptions?.userGroups.find(g => g.id === sub.groupId)?.name ?? null : null;
      const patch: ProductionTechReqEntry = {
        ...task,
        ...data.task,
        title: drawerTitle.trim(),
        description: drawerDescription,
        eventId: drawerEventId || null,
        eventTitle,
        departmentId: sub.departmentId,
        departmentName,
        groupId: sub.groupId,
        groupName,
        startTime: drawerStart ? datetimeLocalToIso(drawerStart) : null,
        endTime: drawerEnd ? datetimeLocalToIso(drawerEnd) : null,
        effectiveStartTime: drawerStart ? datetimeLocalToIso(drawerStart) : data.task?.effectiveStartTime ?? task.effectiveStartTime,
        effectiveEndTime: drawerEnd ? datetimeLocalToIso(drawerEnd) : data.task?.effectiveEndTime ?? task.effectiveEndTime,
      };
      setTasks(current => current.map(item => item.id === task.id ? patch : item));
      setSelected(patch);
      setDrawerEditing(false);
      router.refresh();
    } finally {
      setUpdating(false);
    }
  }

  const events = Array.from(new Map(
    tasks.filter(t => t.eventId != null).map(t => [t.eventId!, t.eventTitle ?? ""] as [string, string])
  ).entries());
  const depts = Array.from(
    new Map(tasks.filter(t => t.departmentId).map(t => [t.departmentId!, t.departmentName!])).entries()
  );

  const hasStandalone = tasks.some(t => !t.eventId);

  const filtered = tasks.filter(t => {
    if (scope === "mine" && !(currentUserId && t.assignees.some(a => a.userId === currentUserId))) return false;
    if (scope === "event" && !t.eventId) return false;  // 仅看关联事件的
    if (selectedEvent === "__standalone" ? t.eventId != null : (selectedEvent !== "all" && t.eventId !== selectedEvent)) return false;
    if (selectedDept !== "all" && t.departmentId !== selectedDept) return false;
    if (statusFilter === "active") return t.status !== "done" || completingIds.has(t.id);
    return t.status === statusFilter;
  });

  // 摘要统计（原型 taskSummary：待处理 / 进行中 / 已阻塞 / 完成度）
  const todayStr = new Date().toDateString();
  const dueToday = tasks.filter(t =>
    t.status !== "done" && t.effectiveEndTime && new Date(t.effectiveEndTime).toDateString() === todayStr
  ).length;
  const summary = {
    pending: tasks.filter(t => t.status === "pending" || t.status === "awaiting").length,
    inProgress: tasks.filter(t => t.status === "in_progress").length,
    blocked: tasks.filter(isBlockedActive).length,
    done: tasks.filter(t => t.status === "done").length,
  };
  const inProgressDepts = new Set(
    tasks.filter(t => t.status === "in_progress" && t.departmentId).map(t => t.departmentId)
  ).size;
  // 本周完成度（原型：按 Task 状态统计）：本周到期（有效结束时间落在周一～周日）的任务中已完成占比
  const now = new Date();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);
  const weekTasks = tasks.filter(t => {
    if (!t.effectiveEndTime) return false;
    const d = new Date(t.effectiveEndTime);
    return d >= weekStart && d < weekEnd;
  });
  const weekDone = weekTasks.filter(t => t.status === "done").length;
  const weekPct = weekTasks.length > 0 ? `${Math.round((weekDone / weekTasks.length) * 100)}%` : "—";
  const weekHint = weekTasks.length > 0
    ? `本周到期 ${weekTasks.length} 项 · 完成 ${weekDone}`
    : "本周无到期任务";

  const visibleSelected = filtered.find(t => t.id === selected?.id) ?? null;

  function countFor(sf: StatusFilter, eventId = selectedEvent, deptId = selectedDept) {
    return tasks.filter(t => {
      if (eventId === "__standalone" ? t.eventId != null : (eventId !== "all" && t.eventId !== eventId)) return false;
      if (deptId !== "all" && t.departmentId !== deptId) return false;
      return sf === "active" ? t.status !== "done" : t.status === sf;
    }).length;
  }

  const createModal = createOpen && (
    <CreateTaskModal
      productionId={productionId}
      onClose={() => setCreateOpen(false)}
      onCreated={() => { setCreateOpen(false); router.refresh(); }}
    />
  );

  if (tasks.length === 0) {
    return (
      <>
        <div className={styles.emptyState}>
          暂无任务
          <small>事件中创建的任务与独立任务都会在这里汇总</small>
          <button
            onClick={() => setCreateOpen(true)}
            style={{
              marginTop: 14, borderRadius: 8, padding: "10px 14px", border: "1px solid var(--ink)",
              cursor: "pointer", fontSize: 12, fontWeight: 700, background: "var(--ink)", color: "#fff",
            }}
          >
            ＋ 新建任务
          </button>
        </div>
        {createModal}
      </>
    );
  }

  const statusFilters: StatusFilter[] = ["active", "awaiting", "pending", "in_progress", "done"];

  return (
    <>
      {/* ── 摘要统计（原型 taskSummary：1px 缝 grid、92px 高、serif 28px 数字）── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1,
        overflow: "hidden", border: "1px solid var(--line)", borderRadius: 14,
        background: "var(--line)", marginBottom: 18,
      }}>
        {[
          [String(summary.pending), "待处理", dueToday > 0 ? `${dueToday} 项今日截止` : "含待认领"],
          [String(summary.inProgress), "进行中", inProgressDepts > 1 ? `跨 ${inProgressDepts} 个部门` : "推进中"],
          [String(summary.blocked), "已阻塞", "等待前置任务"],
          [weekPct, "本周完成度", weekHint],
        ].map(([num, label, hint]) => (
          <div key={label} style={{
            minHeight: 92, padding: "17px 19px", display: "flex", alignItems: "center", gap: 13,
            background: "var(--surface)",
          }}>
            <span style={{
              fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28,
              color: label === "已阻塞" && summary.blocked > 0 ? "var(--danger)" : "var(--ink)",
            }}>{num}</span>
            <p style={{ margin: 0, display: "flex", flexDirection: "column" }}>
              <b style={{ fontSize: 11, color: "var(--ink)" }}>{label}</b>
              <small style={{ marginTop: 3, color: "var(--muted)", fontSize: 9 }}>{hint}</small>
            </p>
          </div>
        ))}
      </div>

      {/* ── Panel（原型排版）：taskToolbar + 三栏（保留现有设计）── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13, padding: 22, height: "calc(100vh - 320px)", minHeight: 460, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        {/* segmented（原型：surface-2 槽 + ink 选中块）+ 筛选下拉（长列表友好，左栏已撤） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, background: "var(--surface-2)", borderRadius: 8, padding: 3 }}>
            {([["mine", "我的任务"], ["all", "全部"], ["event", "关联事件"]] as const).map(([id, label]) => (
              <button key={id} aria-pressed={scope === id} onClick={() => setScope(id)} style={{
                border: 0, borderRadius: 6, padding: "7px 14px", fontSize: 10, fontWeight: 700, cursor: "pointer",
                background: scope === id ? "var(--ink)" : "transparent",
                color: scope === id ? "#fff" : "var(--muted)", transition: "all .1s", whiteSpace: "nowrap",
              }}>{label}</button>
            ))}
          </div>
          <div className={styles.desktopOnly}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(events.length + (hasStandalone ? 1 : 0)) > 1 && (
              <div style={{ width: 190 }}>
                <DropdownPicker
                  items={[
                    ...(hasStandalone ? [{ id: "__standalone", label: `独立任务 (${countFor(statusFilter, "__standalone", selectedDept)})` }] : []),
                    ...events.map(([id, title]) => ({ id, label: `${title} (${countFor(statusFilter, id, selectedDept)})` })),
                  ]}
                  value={selectedEvent === "all" ? null : selectedEvent}
                  placeholder={`全部日程 (${countFor(statusFilter, "all", selectedDept)})`}
                  clearLabel={`全部日程 (${countFor(statusFilter, "all", selectedDept)})`}
                  searchPlaceholder="搜索事件…"
                  onChange={id => setSelectedEvent(id ?? "all")}
                />
              </div>
            )}
            {depts.length > 0 && (
              <div style={{ width: 170 }}>
                <DropdownPicker
                  items={depts.map(([id, name]) => ({ id, label: `${name} (${countFor(statusFilter, selectedEvent, id)})` }))}
                  value={selectedDept === "all" ? null : selectedDept}
                  placeholder={`全部部门 (${countFor(statusFilter, selectedEvent, "all")})`}
                  clearLabel={`全部部门 (${countFor(statusFilter, selectedEvent, "all")})`}
                  searchPlaceholder="搜索部门…"
                  onChange={id => setSelectedDept(id ?? "all")}
                />
              </div>
            )}
            <div style={{ width: 150 }}>
              <DropdownPicker
                items={(["awaiting", "pending", "in_progress", "done"] as StatusFilter[]).map(sf => ({
                  id: sf, label: `${STATUS_FILTER_LABELS[sf]} (${countFor(sf)})`,
                }))}
                value={statusFilter === "active" ? null : statusFilter}
                placeholder={`进行中任务 (${countFor("active")})`}
                clearLabel={`进行中任务 (${countFor("active")})`}
                searchPlaceholder="筛选状态…"
                onChange={id => setStatusFilter((id as StatusFilter) ?? "active")}
              />
            </div>
          </div>
          </div>
        </div>
        {/* taskToolbarActions（原型：在日历中查看 secondary + 新建 primary） */}
        <div style={{ display: "flex", gap: 8 }}>
          <Link
            href={`/production/${productionId}/planning`}
            style={{
              borderRadius: 8, padding: "10px 14px", border: "1px solid var(--ink)",
              cursor: "pointer", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
              background: "transparent", color: "var(--ink)", textDecoration: "none",
            }}
          >
            在日历中查看
          </Link>
          <button
            onClick={() => setCreateOpen(true)}
            style={{
              borderRadius: 8, padding: "10px 14px", border: "1px solid var(--ink)",
              cursor: "pointer", fontSize: 12, fontWeight: 700,
              background: "var(--ink)", color: "#fff", whiteSpace: "nowrap",
            }}
          >
            ＋ 新建 Task
          </button>
        </div>
      </div>

      {/* ── Mobile: filter chips + accordion ── */}
      <div className={styles.mobileOnly}>
        <div className={styles.mobileTaskFilterBar}>
          {(events.length + (hasStandalone ? 1 : 0)) > 1 && (
            <select
              value={selectedEvent}
              onChange={e => setSelectedEvent(e.target.value)}
              style={{
                width: "100%", border: "1px solid var(--line)", borderRadius: 8,
                padding: "8px 12px", fontSize: 12, color: "var(--ink)",
                background: "var(--surface)", outline: "none", cursor: "pointer",
              }}
            >
              <option value="all">所有日程 ({countFor(statusFilter, "all", selectedDept)})</option>
              {hasStandalone && (
                <option value="__standalone">独立任务 ({countFor(statusFilter, "__standalone", selectedDept)})</option>
              )}
              {events.map(([id, title]) => (
                <option key={id} value={id}>{title} ({countFor(statusFilter, id, selectedDept)})</option>
              ))}
            </select>
          )}
          {depts.length > 0 && (
            <select
              value={selectedDept}
              onChange={e => setSelectedDept(e.target.value)}
              style={{
                width: "100%", border: "1px solid var(--line)", borderRadius: 8,
                padding: "8px 12px", fontSize: 12, color: "var(--ink)",
                background: "var(--surface)", outline: "none", cursor: "pointer",
              }}
            >
              <option value="all">所有部门 ({countFor(statusFilter, selectedEvent, "all")})</option>
              {depts.map(([id, name]) => (
                <option key={id} value={id}>{name} ({countFor(statusFilter, selectedEvent, id)})</option>
              ))}
            </select>
          )}
          <div className={styles.mobileTaskStatusScroll}>
            {statusFilters.map(sf => (
              <button
                key={sf}
                onClick={() => setStatusFilter(sf)}
                className={`${styles.mobileTaskChip} ${statusFilter === sf ? styles.active : ""}`}
              >
                {STATUS_FILTER_LABELS[sf]} ({countFor(sf)})
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className={styles.emptyState}>无匹配任务</div>
        ) : (
          <div className={styles.mobileTaskList}>
            {filtered.map(t => {
              const isExpanded = selected?.id === t.id;
              return (
                <div key={t.id} data-task-row className={styles.mobileTaskCard}>
                  <button
                    onClick={() => setSelected(isExpanded ? null : t)}
                    className={styles.mobileTaskCardBtn}
                  >
                    <div className={styles.mobileTaskCardMeta}>
                      <span className={styles.mobileTaskCardKicker}>
                        {relationLabel(t)}
                      </span>
                      {isBlockedActive(t) && <BlockedChip />}
                      <span style={{
                        flexShrink: 0, borderRadius: 6, padding: "3px 8px",
                        fontSize: 10, fontWeight: 700, ...statusBadgeStyle(t.status),
                      }}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </span>
                    </div>
                    <p className={`${styles.mobileTaskCardTitle} ${isExpanded ? "" : styles.mobileTaskCardTitleClamp}`}>
                      {t.title || "待填写需求名称…"}
                    </p>
                    {(t.assignees.length > 0 || dueInfo(t)) && (
                      <p className={styles.mobileTaskCardAssignees}>
                        {t.assignees.map(a => a.name).join("、")}
                        {t.assignees.length > 0 && dueInfo(t) && " · "}
                        {dueInfo(t) && <span style={dueInfo(t)!.style}>{dueInfo(t)!.label}</span>}
                      </p>
                    )}
                  </button>

                  {isExpanded && (
                    <div className={styles.mobileTaskCardDetail}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>更新状态</span>
                        <select
                          disabled={updating}
                          value={t.status}
                          onChange={e => updateStatus(t, e.target.value)}
                          style={{
                            borderRadius: 6, padding: "4px 8px",
                            fontSize: 11, fontWeight: 700, cursor: "pointer",
                            border: "1px solid transparent", outline: "none",
                            opacity: updating ? 0.5 : 1, ...statusBadgeStyle(t.status),
                          }}
                        >
                          {VALID_STATUSES.map(s => (
                            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                          ))}
                        </select>
                      </div>
                      {t.assignees.length > 0 && (
                        <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)" }}>
                          负责人：{t.assignees.map(a => a.name).join("、")}
                        </p>
                      )}
                      {t.description && (
                        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginBottom: 14 }}>
                          <SmartText content={t.description} plugins={[scriptRefTextPlugin]} productionId={productionId} />
                        </div>
                      )}
                      <Link
                        href={`/production/${productionId}/tasks/${t.id}`}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6,
                          border: "1px solid var(--ink)", borderRadius: 8, padding: "9px 18px",
                          fontSize: 12, fontWeight: 700, color: "var(--ink)", textDecoration: "none",
                        }}
                      >
                        前往任务详情 →
                      </Link>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Desktop: 全宽表格（筛选在工具栏下拉，详情走抽屉 peek）── */}
      <div className={styles.desktopOnly} style={{ flex: 1, minHeight: 0 }}>
        <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* Task table（原型 taskTableHeader + taskRows，规格照抄见 my-pages.module.css） */}
          <div style={{ overflowY: "auto", padding: "0 0 24px 0", flex: 1, minHeight: 0 }}>
            {filtered.length === 0 ? (
              <div className={styles.emptyState} style={{ paddingTop: 60 }}>无匹配任务</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div className={styles.taskTableHeader}>
                  <span>状态</span>
                  <span>任务</span>
                  <span>关系</span>
                  <span style={{ textAlign: "right" }}>负责人 / 截止</span>
                </div>
                {filtered.map(t => {
                  const isSelected = visibleSelected?.id === t.id;
                  const isDone = t.status === "done";
                  const due = dueInfo(t);
                  return (
                    <article
                      key={t.id}
                      data-task-row
                      className={[
                        styles.taskRow,
                        isDone ? styles.taskRowDone : "",
                        completingIds.has(t.id) ? styles.taskRowCompleting : "",
                        isSelected ? styles.taskRowSelected : "",
                      ].filter(Boolean).join(" ")}
                    >
                      {/* 勾选圈（原型 taskCheck）：完成/恢复切换 */}
                      <button
                        aria-label={isDone ? `恢复 ${t.title}` : `完成 ${t.title}`}
                        disabled={updating}
                        onClick={() => updateStatus(t, isDone ? "in_progress" : "done")}
                        className={styles.taskCheckBtn}
                      >
                        {isDone ? "✓" : ""}
                      </button>
                      {/* taskTitleCell：点击开抽屉 / 切换；再点同行关（点外部=关的对称面） */}
                      <button
                        onClick={() => setSelected(prev => prev?.id === t.id ? null : t)}
                        className={styles.taskTitleCell}
                      >
                        <b>{t.title || "待填写需求名称…"}</b>
                        <small style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{
                            borderRadius: 5, padding: "2px 7px", fontWeight: 700,
                            ...statusBadgeStyle(t.status),
                          }}>
                            {STATUS_LABEL[t.status] ?? t.status}
                          </span>
                          {isBlockedActive(t) && (
                            <span style={{
                              borderRadius: 5, padding: "2px 7px", fontWeight: 700,
                              background: "var(--danger-soft)", color: "var(--danger)",
                            }}>
                              ⛔ 受阻
                            </span>
                          )}
                        </small>
                      </button>
                      {/* taskRelation：关联事件直达 / 独立任务 */}
                      {t.eventId ? (
                        <Link href={`/production/${productionId}/events/${t.eventId}`} className={styles.taskRelationCell}>
                          <b>{t.eventTitle}{t.departmentName && ` · ${t.departmentName}`}</b>
                          <small>打开关联事件 →</small>
                        </Link>
                      ) : (
                        <span className={styles.taskRelationCell} style={{ cursor: "default" }}>
                          <b>独立任务{t.departmentName && ` · ${t.departmentName}`}</b>
                          <small>未绑定事件</small>
                        </span>
                      )}
                      {/* taskOwner：右对齐 负责人 / 截止 */}
                      <span className={styles.taskOwnerCell}>
                        <small>{t.assignees.length > 0 ? t.assignees.map(a => a.name).join("、") : "未指派"}</small>
                        <b style={due?.style}>{due?.label ?? "—"}</b>
                      </span>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

        </div>
      </div>
      </section>

      {/* ── 任务抽屉（peek，仅桌面；移动端沿用手风琴）：点击行开/切换，点外部/Esc/×/再点同行关 ── */}
      {visibleSelected && (
        <div className={styles.desktopOnly}>
        <aside ref={drawerRef} className={styles.taskDrawer} aria-label="任务详情抽屉">
          {/* drawerHeader（原型规格：kicker + serif 标题 + 圆钮） */}
          <div style={{ minHeight: 92, padding: "20px 22px", borderBottom: "1px solid var(--line)", display: "flex", gap: 15 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase" }}>
                Task
              </p>
              <h2 style={{ margin: "6px 0 0", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 20, fontWeight: 500, color: "var(--ink)", lineHeight: 1.3 }}>
                <Link
                  href={`/production/${productionId}/tasks/${visibleSelected.id}`}
                  style={{ color: "inherit", textDecoration: "none" }}
                  title="打开完整详情页"
                >
                  {visibleSelected.title || "待填写需求名称…"}
                </Link>
              </h2>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "flex-start" }}>
              <Link
                href={`/production/${productionId}/tasks/${visibleSelected.id}`}
                aria-label="打开完整详情页"
                title="打开完整详情页"
                style={{
                  width: 30, height: 30, border: "1px solid var(--line)", borderRadius: "50%",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, color: "var(--ink)", textDecoration: "none",
                }}
              >
                ↗
              </Link>
              <button
                onClick={() => setSelected(null)}
                aria-label="关闭"
                style={{
                  width: 30, height: 30, border: "1px solid var(--line)", borderRadius: "50%",
                  background: "transparent", cursor: "pointer", fontSize: 18, lineHeight: 1, color: "var(--muted)",
                }}
              >
                ×
              </button>
            </div>
          </div>

          {/* drawerBody */}
          <div style={{ padding: 22 }}>
            {/* 关系行 */}
            {visibleSelected.eventId ? (
              <Link
                href={`/production/${productionId}/events/${visibleSelected.eventId}`}
                style={{ display: "inline-block", margin: "0 0 10px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage, var(--muted))", textDecoration: "none" }}
              >
                {visibleSelected.eventTitle}{visibleSelected.departmentName && ` · ${visibleSelected.departmentName}`} →
              </Link>
            ) : (
              <p style={{ margin: "0 0 10px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
                独立任务{visibleSelected.departmentName && ` · ${visibleSelected.departmentName}`}
              </p>
            )}

            {/* 状态推进 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>状态</span>
              <select
                disabled={updating}
                value={visibleSelected.status}
                onChange={e => updateStatus(visibleSelected, e.target.value)}
                style={{
                  borderRadius: 6, padding: "4px 8px",
                  fontSize: 11, fontWeight: 700, cursor: "pointer",
                  border: "1px solid transparent", outline: "none",
                  opacity: updating ? 0.5 : 1, ...statusBadgeStyle(visibleSelected.status),
                }}
              >
                {VALID_STATUSES.map(s => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
              {isBlockedActive(visibleSelected) && <BlockedChip />}
              <button
                type="button"
                onClick={() => drawerEditing ? setDrawerEditing(false) : beginDrawerEdit(visibleSelected)}
                style={{ marginLeft: "auto", border: "1px solid var(--ink)", borderRadius: 7, background: drawerEditing ? "var(--surface-2)" : "transparent", padding: "5px 10px", color: "var(--ink)", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
              >
                {drawerEditing ? "取消编辑" : "编辑任务信息"}
              </button>
            </div>

            {drawerEditing && (
              <div style={{ display: "flex", flexDirection: "column", gap: 11, margin: "4px 0 16px", padding: 13, border: "1px solid var(--line)", borderRadius: 10, background: "var(--paper)" }}>
                <label><span style={FIELD_LABEL}>任务名称</span><input value={drawerTitle} onChange={e => setDrawerTitle(e.target.value)} style={FIELD_INPUT} /></label>
                <label><span style={FIELD_LABEL}>任务说明</span><textarea value={drawerDescription} onChange={e => setDrawerDescription(e.target.value)} rows={3} style={{ ...FIELD_INPUT, resize: "vertical" }} /></label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label><span style={FIELD_LABEL}>开始时间</span><input type="datetime-local" value={drawerStart} onChange={e => setDrawerStart(e.target.value)} style={FIELD_INPUT} /></label>
                  <label><span style={FIELD_LABEL}>结束时间</span><input type="datetime-local" value={drawerEnd} onChange={e => setDrawerEnd(e.target.value)} style={FIELD_INPUT} /></label>
                </div>
                <label>
                  <span style={FIELD_LABEL}>关联事件</span>
                  <select value={drawerEventId} onChange={e => setDrawerEventId(e.target.value)} style={FIELD_INPUT}>
                    <option value="">独立任务</option>
                    {(drawerOptions?.events ?? []).map(event => <option key={event.id} value={event.id}>{event.title}</option>)}
                  </select>
                </label>
                <label>
                  <span style={FIELD_LABEL}>责任方</span>
                  <select value={drawerSubject} onChange={e => setDrawerSubject(e.target.value as SubjectValue)} style={FIELD_INPUT}>
                    <option value="">暂不指定</option>
                    <optgroup label="部门">
                      {(drawerOptions?.depts ?? []).map(dept => <option key={dept.id} value={`dept:${dept.id}`}>{dept.name}</option>)}
                    </optgroup>
                    {(drawerOptions?.userGroups ?? []).length > 0 && (
                      <optgroup label="用户组">
                        {(drawerOptions?.userGroups ?? []).map(g => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                </label>
                {drawerError && <p style={{ margin: 0, color: "var(--danger)", fontSize: 11 }}>{drawerError}</p>}
                <button type="button" disabled={updating} onClick={() => saveDrawerEdit(visibleSelected)} style={{ border: "1px solid var(--ink)", borderRadius: 8, background: "var(--ink)", color: "#fff", padding: "9px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", opacity: updating ? .55 : 1 }}>{updating ? "保存中…" : "保存任务信息"}</button>
              </div>
            )}

            {visibleSelected.assignees.length > 0 && (
              <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)" }}>
                负责人：{visibleSelected.assignees.map(a => a.name).join("、")}
              </p>
            )}
            {visibleSelected.effectiveStartTime && (
              <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)" }}>
                时间：{new Date(visibleSelected.effectiveStartTime).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                {visibleSelected.effectiveEndTime && (
                  <> — <span style={dueInfo(visibleSelected)?.style}>{dueInfo(visibleSelected)?.label}</span></>
                )}
                {!visibleSelected.startTime && <span style={{ fontSize: 10 }}>（继承自{visibleSelected.eventId ? "事件/日程" : "绑定对象"}）</span>}
              </p>
            )}
            {visibleSelected.milestones.length > 0 && (
              <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                里程碑：
                {visibleSelected.milestones.map(m => (
                  <span key={m.id} title={m.endDate} style={{
                    borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                    background: "var(--surface-2)", color: "var(--ink)",
                  }}>
                    ◆ {m.name} · {m.endDate.slice(5).replace("-", "/")}
                  </span>
                ))}
              </p>
            )}
            {isBlockedActive(visibleSelected) && (
              <p style={{
                margin: "10px 0 0", padding: "8px 12px", borderRadius: 8,
                background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12, fontWeight: 600,
              }}>
                ⛔ 被前置任务阻塞——前置任务全部完成前建议暂缓推进（详情页可查看/编辑依赖）
              </p>
            )}
            {visibleSelected.description && (
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: 14, marginBottom: 6 }}>
                <SmartText content={visibleSelected.description} plugins={[scriptRefTextPlugin]} productionId={productionId} />
              </div>
            )}
            <div style={{ marginTop: 18 }}>
              <Link
                href={`/production/${productionId}/tasks/${visibleSelected.id}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  border: "1px solid var(--ink)", borderRadius: 8, padding: "9px 18px",
                  fontSize: 12, fontWeight: 700, color: "var(--ink)", textDecoration: "none",
                }}
              >
                前往任务详情 →
              </Link>
            </div>
          </div>
        </aside>
        </div>
      )}

      {createModal}
    </>
  );
}
