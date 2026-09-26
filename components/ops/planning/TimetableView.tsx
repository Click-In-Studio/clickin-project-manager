"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "@/components/ops/planning.module.css";
import Badge from "@/components/ui/Badge";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import { BASE_PATH } from "@/lib/base-path";
import type { EventScheduleItemWithParticipants, EventTechReq } from "@/lib/ops/event-db";
import { fmtDate } from "@/lib/tz";
import { RundownColumnEditor } from "./RundownColumnEditor";
import RundownEntryEditor from "./RundownEntryEditor";
import { minutesOfIso, fmtMin } from "./date";
import { TASK_STATUS_LABELS } from "./labels";
import { readPref, writePref } from "./prefs";
import type { RundownColumn, ServerUserGroup, ServerRundownColumn, ServerRundownPlacement, RundownEntrySelection, RundownDragEntry } from "./rundown-types";
import type { Props } from "./types";

// 原型 rundown_* 类型配色（call 橙/run 青/task 草绿/break 斜纹/notes 紫；默认=run 青）
const ITEM_TONE: Record<string, { bg: string; border: string }> = {
  call:   { bg: "#f2e3d6", border: "#d9ab8d" },
  run:    { bg: "#dce9e9", border: "rgba(47,102,112,.28)" },
  task:   { bg: "#edf0e5", border: "#c9d0b7" },
  break:  { bg: "repeating-linear-gradient(135deg, #f1f0eb 0, #f1f0eb 8px, #e6e4dc 8px, #e6e4dc 16px)", border: "#d4d1c7" },
  notes:  { bg: "#eee5f0", border: "#cdb9d3" },
  custom: { bg: "#dce9e9", border: "rgba(47,102,112,.28)" },
};

// 泳道各处（grid、sticky left/top、插入入口）必须共用同一套尺寸，否则横向滚动后
// 固定列会与表头、事项块错位。这里保留动态计算，静态外观交给 CSS Module。
const RUNDOWN_TIME_WIDTH = 72;
const RUNDOWN_LANE_MIN_WIDTH = 132;
const RUNDOWN_LOCATION_HEIGHT = 28;
const RUNDOWN_HEADER_HEIGHT = 44;

export default function TimetableView({ productionId, events, departments, members }: Props) {
  const timedEvents = useMemo(
    () => events.filter(e => e.startTime).sort((a, b) => (a.startTime! < b.startTime! ? -1 : 1)),
    [events],
  );
  const [eventId, setEventId] = useState<string>(timedEvents[0]?.id ?? "");
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [items, setItems] = useState<EventScheduleItemWithParticipants[]>([]);
  const [eventTasks, setEventTasks] = useState<EventTechReq[]>([]);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [viewMode, setViewMode] = useState<"all" | "custom">("all");
  const [filtersRestored, setFiltersRestored] = useState(false);
  const [columns, setColumns] = useState<RundownColumn[]>([]);
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<RundownEntrySelection | null>(null);
  const [entryColors, setEntryColors] = useState<Record<string, string>>({});
  const [entryLaneOverrides, setEntryLaneOverrides] = useState<Record<string, string[]>>({});
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const columnsTagRef = useRef("");
  const placementsTagRef = useRef("");
  const layoutSaveInFlightRef = useRef<Promise<void>>(Promise.resolve());
  const placementsSaveInFlightRef = useRef<Promise<void>>(Promise.resolve());
  const layoutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLayoutRef = useRef<RundownColumn[] | null>(null);
  const dragColumnId = useRef<string | null>(null);
  const dragEntryRef = useRef<RundownDragEntry | null>(null);
  const resizeRef = useRef<{ selection: RundownEntrySelection; edge: "start" | "end"; startY: number; startIso: string; endIso: string; nextStart: string; nextEnd: string } | null>(null);

  useEffect(() => {
    try {
      const raw = readPref(`planning-timetable-filters:${productionId}`);
      const saved = raw ? JSON.parse(raw) as { eventId?: unknown; personFilter?: unknown; viewMode?: unknown } : null;
      if (saved?.eventId && typeof saved.eventId === "string" && timedEvents.some(event => event.id === saved.eventId)) {
        setEventId(saved.eventId);
      }
      if (saved?.personFilter === "all" || (typeof saved?.personFilter === "string" && members.some(member => member.userId === saved.personFilter))) {
        setPersonFilter(saved.personFilter);
      }
      if (saved?.viewMode === "all" || saved?.viewMode === "custom") setViewMode(saved.viewMode);
    } catch {
      // 损坏或旧版本的浏览器偏好不应阻断页面，直接回到安全默认值。
    }
    setFiltersRestored(true);
  }, [members, productionId, timedEvents]);

  useEffect(() => {
    if (!filtersRestored) return;
    writePref(
      `planning-timetable-filters:${productionId}`,
      JSON.stringify({ eventId, personFilter, viewMode }),
    );
  }, [eventId, filtersRestored, personFilter, productionId, viewMode]);

  // 版面来自服务端，不再是每人一份的 localStorage——rundown 是 organizer 定好
  // 大家遵守的东西。列 = event_rundown_column ⋈ event_group。
  useEffect(() => {
    // 恢复偏好前不打请求：eventId 的初值是 timedEvents[0]，恢复 effect 的
    // setEventId 要等本轮 effect 全部跑完才生效，不挡就会为默认事件白打一轮。
    if (!filtersRestored) return;
    if (!eventId) {
      setColumns([]);
      columnsTagRef.current = "";
      placementsTagRef.current = "";
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch(`${BASE_PATH}/api/production/${productionId}/user-groups?eventId=${eventId}`).then(r => r.json()).catch(() => ({})),
      fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/rundown`).then(r => r.json()).catch(() => ({})),
    ]).then(([groupRes, layoutRes]) => {
      if (cancelled) return;
      const groups = new Map<string, ServerUserGroup>(
        ((groupRes.groups ?? []) as ServerUserGroup[]).map(g => [g.id, g]),
      );
      setColumns(((layoutRes.columns ?? []) as ServerRundownColumn[]).map(col => {
        const group = col.groupId ? groups.get(col.groupId) : undefined;
        return {
          id: col.id,
          groupId: col.groupId,
          name: group?.name ?? col.matchLocation ?? "未命名",
          kind: col.groupId ? "people" as const : "location" as const,
          departmentIds: (group?.members ?? []).filter(m => m.kind === "dept").map(m => m.id),
          userIds: (group?.members ?? []).filter(m => m.kind === "user").map(m => m.id),
          location: col.matchLocation ?? "",
          visible: col.isVisible,
          pinned: col.isPinned,
        };
      }));
      const colors: Record<string, string> = {};
      const lanes: Record<string, string[]> = {};
      for (const p of (layoutRes.placements ?? []) as ServerRundownPlacement[]) {
        const key = `${p.entryType}:${p.entryId}`;
        if (p.color) colors[key] = p.color;
        if (p.pinnedColumnIds.length) lanes[key] = p.pinnedColumnIds;
      }
      setEntryColors(colors);
      setEntryLaneOverrides(lanes);
      columnsTagRef.current = typeof layoutRes.columnsTag === "string" ? layoutRes.columnsTag : "";
      placementsTagRef.current = typeof layoutRes.placementsTag === "string" ? layoutRes.placementsTag : "";
    });
    return () => { cancelled = true; };
  }, [productionId, eventId, filtersRestored]);

  useEffect(() => {
    if (!filtersRestored || !eventId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule`).then(r => r.json()),
      fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/tech-reqs`).then(r => r.json()).catch(() => ({})),
    ])
      .then(([sched, reqs]: [{ items?: EventScheduleItemWithParticipants[] }, { techReqs?: EventTechReq[] }]) => {
        if (cancelled) return;
        setItems((sched.items ?? []).filter(it => it.startTime && it.endTime));
        // 绑定 event 但未绑 schedule item 的任务上执行表；绑了 schedule 的随条目显示不重复画
        setEventTasks((reqs.techReqs ?? []).filter(t =>
          t.scheduleItemIds.length === 0 && t.effectiveStartTime && t.effectiveEndTime
        ));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [productionId, eventId, filtersRestored]);

  const event = timedEvents.find(e => e.id === eventId) ?? null;

  const lanes = useMemo<RundownColumn[]>(() => {
    if (viewMode === "custom") {
      const active = columns.filter(column => column.visible);
      return active.length ? active : [{ id: "__empty", groupId: null, name: "未选择列", kind: "people", departmentIds: [], userIds: [], location: "", visible: true, pinned: false }];
    }
    const all = departments.map(dept => ({ id: `all-${dept.id}`, groupId: null, name: dept.name, kind: "people" as const, departmentIds: [dept.id], userIds: [], location: "", visible: true, pinned: false }));
    return all.length ? all : [{ id: "__all", groupId: null, name: "全体成员", kind: "people", departmentIds: [], userIds: [], location: "", visible: true, pinned: false }];
  }, [columns, departments, viewMode]);

  // 人员选项：schedule 参与人 + 任务 assignee 聚合
  const people = useMemo(() => members.map(member => [member.userId, member.name] as [string, string]), [members]);
  const memberById = useMemo(() => new Map(members.map(member => [member.userId, member])), [members]);
  const roleOptions = useMemo(() => [...new Set(members.flatMap(member => member.roles))].sort((a, b) => a.localeCompare(b, "zh-CN")), [members]);

  const visibleItems = personFilter === "all"
    ? items
    : items.filter(it => it.participants.some(p => p.userId === personFilter) || it.itemType === "break");
  const visibleTasks = personFilter === "all"
    ? eventTasks
    : eventTasks.filter(t => t.assignees.some(a => a.userId === personFilter));

  // 时间轴：15 分钟粒度（schedule 与任务共同决定范围）
  const SLOT = 15;
  const allStarts = [
    ...items.map(it => minutesOfIso(it.startTime!)),
    ...eventTasks.map(t => minutesOfIso(t.effectiveStartTime!)),
  ];
  const allEnds = [
    ...items.map(it => minutesOfIso(it.endTime!)),
    ...eventTasks.map(t => minutesOfIso(t.effectiveEndTime!)),
  ];
  const startMin = allStarts.length ? Math.floor(Math.min(...allStarts) / SLOT) * SLOT : 0;
  const endMin = allEnds.length ? Math.ceil(Math.max(...allEnds) / SLOT) * SLOT : 0;
  const slots = Array.from({ length: Math.max(0, (endMin - startMin) / SLOT) }, (_, i) => startMin + i * SLOT);
  /**
   * 地点带从**事项自己的 location** 推导，不再是独立实体。
   *
   * 地点是 event_schedule_item.location（早就有），一列的人 9 点在主剧场、14 点在
   * A3——在列上另存一份地点答不出这个，还会跟事项那份打架。这里显示的是「这一列
   * 当前的事项都在哪儿」，改地点去改事项，单一真相。
   */
  const laneLocations = useMemo(() => lanes.map(lane => {
    const locs = new Set(
      items.filter(it => it.location.trim() && itemMatchesColumn(it, lane)).map(it => it.location.trim()),
    );
    return [...locs];
  }), [lanes, items]);   // eslint-disable-line react-hooks/exhaustive-deps

  const hasLocationRow = laneLocations.some(l => l.length > 0);
  const headerRow = hasLocationRow ? 2 : 1;
  const bodyRowStart = headerRow + 1;

  const locationSegments = useMemo(() => {
    if (!hasLocationRow) return [] as { key: string; label: string; start: number; span: number }[];
    const result: { key: string; label: string; start: number; span: number }[] = [];
    laneLocations.forEach((locs, index) => {
      const label = locs.join(" / ");
      const previous = result[result.length - 1];
      if (previous && previous.label === label) previous.span += 1;
      else result.push({ key: `loc-${index}`, label, start: index + 2, span: 1 });
    });
    return result;
  }, [hasLocationRow, laneLocations]);

  function itemMatchesColumn(item: EventScheduleItemWithParticipants, column: RundownColumn): boolean {
    if (column.kind === "location") return !!column.location && item.location.trim() === column.location.trim();
    if (viewMode === "all" && item.departmentIds.length === 0 && item.participants.length === 0) return true;
    const hasRule = column.departmentIds.length + column.userIds.length > 0;
    if (!hasRule) return true;
    if (item.departmentIds.some(id => column.departmentIds.includes(id))) return true;
    return item.participants.some(participant => {
      const member = memberById.get(participant.userId);
      return column.userIds.includes(participant.userId)
        || !!member?.departmentIds.some(id => column.departmentIds.includes(id));
    });
  }

  function taskMatchesColumn(task: EventTechReq, column: RundownColumn): boolean {
    if (column.kind === "location") return !!column.location && event?.location.trim() === column.location.trim();
    if (viewMode === "all" && !task.departmentId && task.assignees.length === 0) return true;
    const hasRule = column.departmentIds.length + column.userIds.length > 0;
    if (!hasRule) return true;
    if (task.departmentId && column.departmentIds.includes(task.departmentId)) return true;
    return task.assignees.some(assignee => {
      const member = memberById.get(assignee.userId);
      return column.userIds.includes(assignee.userId)
        || !!member?.departmentIds.some(id => column.departmentIds.includes(id));
    });
  }

  function placements(indexes: number[]): { start: number; span: number }[] {
    if (!indexes.length) return [];
    const idx = [...indexes].sort((a, b) => a - b);
    if (!idx.length) return [{ start: 2, span: lanes.length }];
    const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    return contiguous
      ? [{ start: idx[0] + 2, span: idx[idx.length - 1] - idx[0] + 1 }]
      : idx.map(i => ({ start: i + 2, span: 1 }));
  }

  function rowOf(startIso: string, endIso: string): { rowStart: number; rowSpan: number } {
    const rowStart = Math.max(bodyRowStart, Math.floor((minutesOfIso(startIso) - startMin) / SLOT) + bodyRowStart);
    const rowSpan = Math.max(1, Math.ceil((minutesOfIso(endIso) - minutesOfIso(startIso)) / SLOT));
    return { rowStart, rowSpan };
  }

  /**
   * 版面落库：顺序 / 显隐 / 粘性 / 地点列。列身份由服务端按 group|地点 认。
   *
   * opts 只给切事件时的 flush 用：expectedTag 是卸载当刻同步捕获的旧事件指纹
   * （共享 ref 随后会被新事件的 GET 覆盖，落盘时不能再读）；applyResult=false
   * 表示不回写指纹与列状态——那时组件已经在渲染新事件了。
   */
  const persistLayout = useCallback(async (
    next: RundownColumn[],
    opts?: { expectedTag?: string; applyResult?: boolean },
  ) => {
    if (!eventId) return;
    const applyResult = opts?.applyResult ?? true;
    if (applyResult) setLayoutError(null);
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/rundown`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedColumnsTag: (opts?.expectedTag ?? columnsTagRef.current) || undefined,
        columns: next.map(c => c.kind === "location"
          ? { matchLocation: c.location, isVisible: c.visible, isPinned: c.pinned }
          : { groupId: c.groupId, isVisible: c.visible, isPinned: c.pinned }),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (applyResult)
        setLayoutError(res.status === 409 ? "版面已被其他成员更新，请刷新页面后再编辑" : (data.error ?? "版面保存失败"));
      return;
    }
    if (!applyResult) return;
    if (typeof data.columnsTag === "string") columnsTagRef.current = data.columnsTag;
    // 用服务端回来的 id 回填——新建的列在本地是 `new-*`，条目钉列要引用真实 id。
    // 服务端按 order_index 返回，而 order_index 就是这次入参的下标，故按位对齐。
    const serverColumns = (data.columns ?? []) as ServerRundownColumn[];
    setColumns(next.map((c, i) => serverColumns[i] ? { ...c, id: serverColumns[i].id } : c));
  }, [productionId, eventId]);

  /** 同一浏览器的保存严格串行，避免自己的两个请求也拿着同一个旧指纹互撞。 */
  const saveLayout = useCallback((next: RundownColumn[]) => {
    // 立即保存的 next 构建自最新列状态，已经包含 pending 里的改动；把防抖计时器
    // 一并取消，否则它稍后会拿着**不含本次新列**的过期版面、顶着刚刷新的指纹
    // 再写一遍，把这里刚建的列静默删掉。
    if (layoutDebounceRef.current) {
      clearTimeout(layoutDebounceRef.current);
      layoutDebounceRef.current = null;
    }
    pendingLayoutRef.current = null;
    const run = layoutSaveInFlightRef.current
      .catch(() => undefined)
      .then(() => persistLayout(next));
    layoutSaveInFlightRef.current = run;
    return run;
  }, [persistLayout]);

  /** 连续拖列/切显隐合并为一次写入；需要服务端 id 的新列仍走立即保存。 */
  const queueLayoutSave = useCallback((next: RundownColumn[]) => {
    pendingLayoutRef.current = next;
    if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
    layoutDebounceRef.current = setTimeout(() => {
      const pending = pendingLayoutRef.current;
      pendingLayoutRef.current = null;
      layoutDebounceRef.current = null;
      if (pending) void saveLayout(pending);
    }, 300);
  }, [saveLayout]);

  // 切事件/卸载时把 pending 的防抖保存冲掉，而不是丢弃——否则最后 300ms 内的
  // 修改会静默消失。cleanup 闭包持有的是旧事件的 persistLayout，落的是旧事件。
  useEffect(() => () => {
    if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
    layoutDebounceRef.current = null;
    const pending = pendingLayoutRef.current;
    pendingLayoutRef.current = null;
    if (!pending) return;
    const expectedTag = columnsTagRef.current || undefined;
    const run = layoutSaveInFlightRef.current
      .catch(() => undefined)
      .then(() => persistLayout(pending, { expectedTag, applyResult: false }));
    layoutSaveInFlightRef.current = run;
  }, [persistLayout]);

  /** 条目表现落库：颜色 + 钉列。 */
  const persistPlacements = useCallback(async (
    colors: Record<string, string>, lanes: Record<string, string[]>,
  ) => {
    if (!eventId) return;
    const keys = [...new Set([...Object.keys(colors), ...Object.keys(lanes)])];
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/rundown`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedPlacementsTag: placementsTagRef.current || undefined,
        placements: keys.map(key => {
          const [entryType, ...rest] = key.split(":");
          return {
            entryType, entryId: rest.join(":"),
            color: colors[key] ?? null,
            // 服务端只认本 event 版面里的列 id，本地未保存的 `new-*` 先滤掉
            pinnedColumnIds: (lanes[key] ?? []).filter(id => !id.startsWith("new-") && !id.startsWith("all-") && !id.startsWith("__")),
          };
        }),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLayoutError(res.status === 409 ? "事项版面已被其他成员更新，请刷新页面后再编辑" : (data.error ?? "事项表现保存失败"));
      return;
    }
    if (typeof data.placementsTag === "string") placementsTagRef.current = data.placementsTag;
  }, [productionId, eventId]);

  const savePlacements = useCallback((
    colors: Record<string, string>, lanes: Record<string, string[]>,
  ) => {
    const run = placementsSaveInFlightRef.current
      .catch(() => undefined)
      .then(() => persistPlacements(colors, lanes));
    placementsSaveInFlightRef.current = run;
    return run;
  }, [persistPlacements]);

  /**
   * 改列的展示属性（显隐 / 粘性）——只动版面，不动用户组。
   *
   * 先算好 next 再 setColumns，**不在 updater 里发请求**：updater 必须是纯函数，
   * StrictMode 下它会被调两次，副作用写在里面就会打两次 PUT。
   */
  function updateColumn(id: string, patch: Partial<RundownColumn>) {
    const next = columns.map(column => column.id === id ? { ...column, ...patch } : column);
    setColumns(next);
    queueLayoutSave(next);
  }

  /**
   * 改列的名称 / 成员——那是**用户组**的属性，落到 /user-groups。
   * 组是跨 event 共享的实体，所以这里改名会影响所有引用它的 rundown，这是有意的。
   */
  async function saveColumnGroup(column: RundownColumn, patch: { name?: string; departmentIds?: string[]; userIds?: string[] }) {
    const name = patch.name ?? column.name;
    const departmentIds = patch.departmentIds ?? column.departmentIds;
    const userIds = patch.userIds ?? column.userIds;
    const members = [
      ...departmentIds.map(id => ({ kind: "dept" as const, id })),
      ...userIds.map(id => ({ kind: "user" as const, id })),
    ];
    setLayoutError(null);

    if (!column.groupId) {
      // 新列：先建 A 型组（绑本 event），再把它排进版面
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/user-groups`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, name, members, poc: null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setLayoutError(data.error ?? "用户组创建失败"); return; }
      const next = columns.map(c => c.id === column.id
        ? { ...c, groupId: data.group.id as string, name, departmentIds, userIds } : c);
      setColumns(next);
      await saveLayout(next);
      return;
    }

    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/user-groups/${column.groupId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, members }),
    });
    if (!res.ok) { setLayoutError((await res.json().catch(() => ({}))).error ?? "用户组保存失败"); return; }
    setColumns(current => current.map(c => c.id === column.id ? { ...c, name, departmentIds, userIds } : c));
  }

  function toggleColumnValue(id: string, key: "departmentIds" | "userIds", value: string) {
    const column = columns.find(c => c.id === id);
    if (!column) return;
    const values = column[key];
    void saveColumnGroup(column, {
      [key]: values.includes(value) ? values.filter(item => item !== value) : [...values, value],
    });
  }

  /** 角色 chip：按角色批量勾/取消人员。role 不落库（可配置表会改名），落的是人。 */
  function toggleColumnRole(id: string, role: string) {
    const column = columns.find(c => c.id === id);
    if (!column) return;
    const roleUserIds = members.filter(m => m.roles.includes(role)).map(m => m.userId);
    const allIn = roleUserIds.length > 0 && roleUserIds.every(uid => column.userIds.includes(uid));
    void saveColumnGroup(column, {
      userIds: allIn
        ? column.userIds.filter(uid => !roleUserIds.includes(uid))
        : [...new Set([...column.userIds, ...roleUserIds])],
    });
  }

  function addColumn(kind: RundownColumn["kind"] = "people", insertAt = columns.length) {
    const suffix = columns.filter(column => column.kind === kind).length + 1;
    const nextColumn: RundownColumn = {
      id: `new-${Date.now()}-${suffix}`,
      groupId: null,
      name: kind === "people" ? `人员组 ${suffix}` : `地点 ${suffix}`,
      kind,
      departmentIds: [], userIds: [], location: "", visible: true, pinned: false,
    };
    const next = [...columns];
    next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, nextColumn);
    setColumns(next);
    setViewMode("custom");
    setEditingColumnId(nextColumn.id);
    // people 列要等用户填了名称/成员才建组；location 列可以直接落库
    if (kind === "location") void saveLayout(next);
  }

  function removeColumn(id: string) {
    const next = columns.filter(c => c.id !== id);
    setColumns(next);
    setEditingColumnId(null);
    queueLayoutSave(next);
  }

  function dropColumn(targetId: string) {
    const sourceId = dragColumnId.current;
    dragColumnId.current = null;
    if (!sourceId || sourceId === targetId) return;
    const from = columns.findIndex(column => column.id === sourceId);
    const to = columns.findIndex(column => column.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...columns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setColumns(next);
    queueLayoutSave(next);
  }

  function entryKey(selection: RundownEntrySelection): string {
    return `${selection.kind}:${selection.id}`;
  }

  function laneIndexes(selection: RundownEntrySelection, fallback: number[]): number[] {
    const override = entryLaneOverrides[entryKey(selection)];
    if (!override?.length) return fallback;
    return override.map(id => lanes.findIndex(lane => lane.id === id)).filter(index => index >= 0);
  }

  function isoAtMinutes(iso: string, minuteOfDay: number): string {
    const next = new Date(iso);
    next.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
    return next.toISOString();
  }

  async function dropEntryAt(lane: RundownColumn, minuteOfDay: number) {
    const dragging = dragEntryRef.current;
    dragEntryRef.current = null;
    if (!dragging) return;
    const key = entryKey(dragging);
    const nextLanes = { ...entryLaneOverrides, [key]: [lane.id] };
    setEntryLaneOverrides(nextLanes);
    void savePlacements(entryColors, nextLanes);
    if (dragging.kind === "item") {
      const item = items.find(entry => entry.id === dragging.id);
      if (!item?.startTime || !item.endTime) return;
      const startTime = isoAtMinutes(item.startTime, minuteOfDay);
      const endTime = new Date(new Date(startTime).getTime() + dragging.duration * 60_000).toISOString();
      await saveItemTime(item, startTime, endTime);
    } else {
      const task = eventTasks.find(entry => entry.id === dragging.id);
      if (!task?.effectiveStartTime || !task.effectiveEndTime) return;
      const startTime = isoAtMinutes(task.effectiveStartTime, minuteOfDay);
      const endTime = new Date(new Date(startTime).getTime() + dragging.duration * 60_000).toISOString();
      // 拖拽**只改时间**。原来还顺手把 departmentId 改成 lane.departmentIds[0]——
      // 那是 POC 的来源，用一个"挪一下位置"的轻手势改责任方是事故；何况取 [0] 会
      // 在列有多个部门时静默丢弃其余。落到哪一列已经由 placements 记下了。
      await saveTaskTime(task, startTime, endTime);
    }
  }

  function beginResize(event: React.PointerEvent<HTMLElement>, selection: RundownEntrySelection, edge: "start" | "end", startIso: string, endIso: string) {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { selection, edge, startY: event.clientY, startIso, endIso, nextStart: startIso, nextEnd: endIso };
  }

  function moveResize(event: React.PointerEvent<HTMLElement>) {
    const state = resizeRef.current;
    if (!state) return;
    const delta = Math.round((event.clientY - state.startY) / 38) * SLOT;
    const startMs = new Date(state.startIso).getTime();
    const endMs = new Date(state.endIso).getTime();
    const nextStartMs = state.edge === "start" ? Math.min(startMs + delta * 60_000, endMs - SLOT * 60_000) : startMs;
    const nextEndMs = state.edge === "end" ? Math.max(endMs + delta * 60_000, startMs + SLOT * 60_000) : endMs;
    state.nextStart = new Date(nextStartMs).toISOString();
    state.nextEnd = new Date(nextEndMs).toISOString();
    if (state.selection.kind === "item") setItems(current => current.map(item => item.id === state.selection.id ? { ...item, startTime: state.nextStart, endTime: state.nextEnd } : item));
    else setEventTasks(current => current.map(task => task.id === state.selection.id ? { ...task, startTime: state.nextStart, endTime: state.nextEnd, effectiveStartTime: state.nextStart, effectiveEndTime: state.nextEnd } : task));
  }

  async function finishResize(event: React.PointerEvent<HTMLElement>) {
    const state = resizeRef.current;
    if (!state) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.selection.kind === "item") {
      const item = items.find(entry => entry.id === state.selection.id);
      if (item) await saveItemTime(item, state.nextStart, state.nextEnd);
    } else {
      const task = eventTasks.find(entry => entry.id === state.selection.id);
      if (task) await saveTaskTime(task, state.nextStart, state.nextEnd);
    }
  }

  async function saveItemTime(item: EventScheduleItemWithParticipants, startTime: string, endTime: string) {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule/${item.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startTime, endTime }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "日程时间保存失败");
    setItems(current => current.map(entry => entry.id === item.id ? { ...entry, startTime, endTime } : entry));
  }

  /** 只改时间。责任方（department_id / group_id）不在这里动——见 dropEntryAt 的注释。 */
  async function saveTaskTime(task: EventTechReq, startTime: string, endTime: string) {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${task.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startTime, endTime }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "任务时间保存失败");
    setEventTasks(current => current.map(entry => entry.id === task.id ? { ...entry, startTime, endTime, effectiveStartTime: startTime, effectiveEndTime: endTime } : entry));
  }

  async function saveSelectedEntry(selection: RundownEntrySelection, draft: { title: string; description: string; start: string; end: string; location: string; itemType: string; status: string; laneIds: string[]; color: string }) {
    const key = entryKey(selection);
    const nextColors = { ...entryColors, [key]: draft.color };
    const nextLanes = { ...entryLaneOverrides, [key]: draft.laneIds };
    setEntryColors(nextColors);
    setEntryLaneOverrides(nextLanes);
    void savePlacements(nextColors, nextLanes);
    // 选中的列拆成两类：绑用户组的走组通道，纯部门派生的（"全部"视图的兜底列）
    // 才落 departmentIds。原来一律 flatMap(lane.departmentIds) 压扁成部门，有两个
    // 问题：组里的**个人成员**（那个助理舞监、几个 runner）从头到尾没参与计算，
    // 而且 setScheduleItemDepartments 是全量覆盖，事项原有的部门会被顺手删掉。
    const chosen = draft.laneIds.map(id => lanes.find(lane => lane.id === id)).filter((l): l is RundownColumn => !!l);
    const chosenGroupIds = [...new Set(chosen.map(l => l.groupId).filter((g): g is string => !!g))];
    const chosenDeptIds = [...new Set(chosen.filter(l => !l.groupId).flatMap(l => l.departmentIds))];

    if (selection.kind === "item") {
      const item = items.find(entry => entry.id === selection.id);
      if (!item) return;
      // 没有任何纯部门列被选中时不动 departmentIds——避免"选了两个组"把事项原有的
      // 部门关联清空
      const deptPatch = chosenDeptIds.length ? { departmentIds: chosenDeptIds } : {};
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule/${item.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, notes: draft.description, startTime: draft.start, endTime: draft.end, location: draft.location, itemType: draft.itemType, ...deptPatch }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "日程保存失败");

      const groupRes = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${eventId}/schedule/${item.id}/groups`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupIds: chosenGroupIds }),
      });
      if (!groupRes.ok) throw new Error((await groupRes.json().catch(() => ({}))).error ?? "人员组绑定失败");

      setItems(current => current.map(entry => entry.id === item.id ? { ...entry, title: draft.title, notes: draft.description, startTime: draft.start, endTime: draft.end, location: draft.location, itemType: draft.itemType, ...(chosenDeptIds.length ? { departmentIds: chosenDeptIds } : {}) } : entry));
    } else {
      const task = eventTasks.find(entry => entry.id === selection.id);
      if (!task) return;
      // task 的责任主体是**单值**（POC 必须唯一）。选了正好一个组 → 绑组；
      // 选了正好一个纯部门列且只带一个部门 → 绑部门；其余情况（多选、混选）
      // 不猜，保持原样——猜错等于改了责任方。
      const subject =
        chosenGroupIds.length === 1 && chosenDeptIds.length === 0 ? { groupId: chosenGroupIds[0] }
        : chosenGroupIds.length === 0 && chosenDeptIds.length === 1 ? { departmentId: chosenDeptIds[0] }
        : {};
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/tasks/${task.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, description: draft.description, startTime: draft.start, endTime: draft.end, status: draft.status, ...subject }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "任务保存失败");
      setEventTasks(current => current.map(entry => entry.id === task.id ? { ...entry, ...data.task, title: draft.title, description: draft.description, status: draft.status, startTime: draft.start, endTime: draft.end, effectiveStartTime: draft.start, effectiveEndTime: draft.end } : entry));
    }
  }

  const editingColumn = columns.find(column => column.id === editingColumnId) ?? null;
  const selectedItem = selectedEntry?.kind === "item" ? items.find(item => item.id === selectedEntry.id) ?? null : null;
  const selectedTask = selectedEntry?.kind === "task" ? eventTasks.find(task => task.id === selectedEntry.id) ?? null : null;
  const selectedLaneIds = selectedEntry
    ? entryLaneOverrides[entryKey(selectedEntry)] ?? lanes.filter(lane => selectedItem ? itemMatchesColumn(selectedItem, lane) : selectedTask ? taskMatchesColumn(selectedTask, lane) : false).map(lane => lane.id)
    : [];

  return (
    <section className={styles.timetablePanel}>
      {/* timetableHeader */}
      <div className={styles.timetableHeader}>
        <div className={styles.timetableTitleBlock}>
          <p className={styles.timetableEyebrow}>
            {event?.startTime ? fmtDate(event.startTime) : "Rundown"}
          </p>
          <h2 className={styles.timetableTitle}>
            Rundown / 现场执行表
          </h2>
          <small className={styles.timetableMeta}>
            {event ? [event.location, "15 分钟粒度"].filter(Boolean).join(" · ") : "选择事件查看执行表"}
          </small>
        </div>
        {event && (
          <div className={styles.timetableActions}>
            <Badge tone="blue">{items.length} 个条目</Badge>
            {eventTasks.length > 0 && <Badge tone="green">{eventTasks.length} 个任务</Badge>}
            {editMode && <button type="button" onClick={() => addColumn("location")} className={styles.timetableSecondaryAction}>＋ 新增地点列</button>}
            <button type="button" onClick={() => { setEditMode(value => { const next = !value; if (next) setViewMode("custom"); else { setEditingColumnId(null); setSelectedEntry(null); } return next; }); }} className={`${styles.timetableEditAction} ${editMode ? styles.timetableEditActionActive : ""}`}>{editMode ? "完成编辑" : "编辑执行表"}</button>
          </div>
        )}
      </div>

      {/* 版面保存失败要看得见——原来存 localStorage 不会失败，现在会（权限不足、
          归档项目、并发改动），静默吞掉的话 organizer 以为排好了其实没存上 */}
      {layoutError && (
        <p role="alert" className={styles.timetableAlert}>
          {layoutError}
          <button type="button" onClick={() => setLayoutError(null)} className={styles.timetableAlertClose}>×</button>
        </p>
      )}

      {/* rundownControls（原型：三格卡片行——事件选择 / 工作流筛选 / 当前人说明） */}
      <div className={styles.rundownControls}>
        <label className={`${styles.rundownControlCard} ${styles.rundownControlPrimary}`}>
          <span className={styles.rundownControlLabel}>日期 / 事件</span>
          <OverflowSafeSelect value={eventId} onChange={e => { setEventId(e.target.value); setPersonFilter("all"); }} className={styles.rundownControlSelect}>
            {timedEvents.map(e => (
              <option key={e.id} value={e.id}>
                {e.startTime ? `${fmtDate(e.startTime)} · ` : ""}{e.title}
              </option>
            ))}
          </OverflowSafeSelect>
        </label>
        <label className={styles.rundownControlCard}>
          <span className={styles.rundownControlLabel}>列视图</span>
          <OverflowSafeSelect value={viewMode} onChange={e => setViewMode(e.target.value as "all" | "custom")} className={styles.rundownControlSelect}>
            <option value="all">全员视图</option>
            <option value="custom">自定义关注列</option>
          </OverflowSafeSelect>
        </label>
        <label className={styles.rundownControlCard}>
          <span className={styles.rundownControlLabel}>关注成员</span>
          <OverflowSafeSelect value={personFilter} onChange={e => setPersonFilter(e.target.value)} className={styles.rundownControlSelect}>
            <option value="all">全部成员</option>
            {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </OverflowSafeSelect>
        </label>
      </div>

      {/* 泳道矩阵 */}
      {!event ? (
        <p className={styles.timetableEmpty}>暂无带时间的事件。</p>
      ) : loading ? (
        <p className={styles.timetableEmpty}>加载中…</p>
      ) : items.length === 0 && eventTasks.length === 0 ? (
        <div className={styles.timetableEmptyState}>
          <p>这个事件还没有执行流程。</p>
          <Link
            href={`/production/${productionId}/events/${event.id}`}
            className={styles.timetableEmptyAction}
          >
            ＋ 前往事件详情添加第一项
          </Link>
        </div>
      ) : (
        /* 原型 rundownMatrixWrap：690px 限高滚动容器 + 38px 横纹底 + sticky 表头/时间列 */
        <div className={styles.rundownMatrixWrap}>
          <div style={{
            display: "grid",
            gridTemplateColumns: `${RUNDOWN_TIME_WIDTH}px repeat(${lanes.length}, minmax(${RUNDOWN_LANE_MIN_WIDTH}px, 1fr))`,
            gridTemplateRows: `${hasLocationRow ? `${RUNDOWN_LOCATION_HEIGHT}px ` : ""}${RUNDOWN_HEADER_HEIGHT}px repeat(${slots.length}, 38px)`,
            minWidth: RUNDOWN_TIME_WIDTH + lanes.length * RUNDOWN_LANE_MIN_WIDTH,
            position: "relative",
            background: "repeating-linear-gradient(to bottom, transparent 0, transparent 37px, rgba(122,139,134,.18) 37px, rgba(122,139,134,.18) 38px)",
          }}>
            {/* 角格（sticky 双向） */}
            <div style={{
              gridColumn: 1, gridRow: hasLocationRow ? "1 / span 2" : 1, position: "sticky", top: 0, left: 0, zIndex: 30,
              padding: "7px 8px", borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
              background: "var(--ink)", color: "#fff", display: "flex", flexDirection: "column",
            }}>
              <b className={styles.rundownTimeHeading}>时间</b>
              <small className={styles.rundownTimeHint}>15 分钟</small>
              {editMode && <button type="button" className={styles.firstInsertButton} aria-label="在第一列前插入人员组" onClick={() => addColumn("people", 0)}><span className={styles.insertColumnGlyph} aria-hidden="true">+</span></button>}
            </div>
            {hasLocationRow && locationSegments.map(segment => (
              <div
                key={segment.key}
                style={{
                  gridColumn: `${segment.start} / span ${segment.span}`, gridRow: 1, position: "sticky", top: 0, zIndex: 16,
                  borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)", padding: "4px 8px",
                  background: segment.label ? "#d9e4e1" : "#edf0ed", color: "var(--ink)", overflow: "hidden",
                }}
                title={segment.label ? `这一列的事项在：${segment.label}` : "这一列的事项没有填地点"}
              >
                <b className={styles.rundownLocationLabel}>
                  {segment.label || "未填地点"}
                </b>
              </div>
            ))}
            {/* 泳道表头（sticky top，ink 底白字） */}
            {lanes.map((lane, i) => {
              const pinnedIndex = lanes.slice(0, i).filter(column => column.pinned).length;
              return (
                <div
                  key={lane.id}
                  className={styles.rundownColumnHeader}
                  draggable={editMode}
                  onDragStart={event => { if ((event.target as HTMLElement).closest("button")) return; dragColumnId.current = lane.id; event.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={event => { if (dragColumnId.current) event.preventDefault(); }}
                  onDrop={() => dropColumn(lane.id)}
                  onDoubleClick={() => {
                    if (!editMode) return;
                    setSelectedEntry(null);
                    setEditingColumnId(lane.id);
                  }}
                  title={editMode ? "长按拖动调整顺序；双击编辑人员组" : lane.name}
                  style={{
                    gridColumn: i + 2, gridRow: headerRow, position: "sticky", top: hasLocationRow ? RUNDOWN_LOCATION_HEIGHT : 0,
                    left: lane.pinned ? RUNDOWN_TIME_WIDTH + pinnedIndex * RUNDOWN_LANE_MIN_WIDTH : undefined, zIndex: lane.pinned ? 24 : 14,
                    padding: "7px 8px", borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                    background: lane.pinned ? "#294340" : "var(--ink)", color: "#fff", display: "flex", flexDirection: "column",
                    cursor: editMode ? "grab" : "default",
                  }}
                >
                  <b className={styles.rundownLaneTitle} style={{ paddingRight: editMode ? 28 : 0 }}>{lane.pinned ? "▣ " : ""}{lane.name}</b>
                  {editMode && <>
                    <button type="button" draggable={false} className={styles.columnMenuButton} aria-label={`编辑人员组 ${lane.name}`} aria-expanded={editingColumnId === lane.id} onClick={event => { event.stopPropagation(); setSelectedEntry(null); setEditingColumnId(current => current === lane.id ? null : lane.id); }}><span aria-hidden="true">⌄</span></button>
                    <button type="button" draggable={false} className={styles.insertColumnButton} aria-label={`在 ${lane.name} 右侧插入人员组`} onClick={event => { event.stopPropagation(); addColumn("people", i + 1); }}><span className={styles.insertColumnGlyph} aria-hidden="true">+</span></button>
                  </>}
                </div>
              );
            })}
            {/* 时间列（sticky left，#f2f2ed 底，monospace） */}
            {slots.map((m, i) => (
              <div key={m} style={{
                gridColumn: 1, gridRow: i + bodyRowStart, position: "sticky", left: 0, zIndex: 12,
                padding: "7px 8px", borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                background: "#f2f2ed", display: "flex", flexDirection: "column",
              }}>
                <b style={{ fontFamily: "monospace", fontSize: 10, color: "var(--ink)" }}>{fmtMin(m)}</b>
                <small style={{ marginTop: 2, color: "var(--muted)", fontSize: 7 }}>{i % 2 === 0 ? "15 min" : ""}</small>
              </div>
            ))}
            {editMode && slots.flatMap((minute, slotIndex) => lanes.map((lane, laneIndex) => (
              <div
                key={`drop-${minute}-${lane.id}`}
                className={styles.rundownDropCell}
                style={{ gridColumn: laneIndex + 2, gridRow: slotIndex + bodyRowStart }}
                onDragOver={event => { if (dragEntryRef.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
                onDrop={event => { event.preventDefault(); void dropEntryAt(lane, minute); }}
                aria-label={`${fmtMin(minute)} ${lane.name} 放置区`}
              />
            )))}
            {/* 条目 cell（原型 rundownCell：2px margin、类型底色、阴影） */}
            {visibleItems.flatMap(it => {
              const selection: RundownEntrySelection = { kind: "item", id: it.id };
              const indexes = laneIndexes(selection, lanes.map((column, index) => itemMatchesColumn(it, column) ? index : -1).filter(index => index >= 0));
              return placements(indexes).map((pl, pi) => {
              const { rowStart, rowSpan } = rowOf(it.startTime!, it.endTime!);
              const tone = ITEM_TONE[it.itemType] ?? ITEM_TONE.custom;
              const dur = minutesOfIso(it.endTime!) - minutesOfIso(it.startTime!);
              const laneIndex = pl.start - 2;
              const pinnedIndex = lanes.slice(0, laneIndex).filter(column => column.pinned).length;
              const sticky = pl.span === 1 && lanes[laneIndex]?.pinned;
              const selected = selectedEntry?.kind === "item" && selectedEntry.id === it.id;
              return (
                <article
                  key={`${it.id}-${pi}`}
                  draggable={editMode}
                  onDragStart={event => { if (!editMode) { event.preventDefault(); return; } dragEntryRef.current = { ...selection, duration: dur }; event.dataTransfer.effectAllowed = "move"; }}
                  onClick={() => editMode && setSelectedEntry(selection)}
                  onDoubleClick={() => editMode && setSelectedEntry(selection)}
                  title={editMode ? "拖动到新的人员组或时间；拖动上下边缘调整长度；点击编辑" : it.title}
                  style={{
                  gridColumn: `${pl.start} / span ${pl.span}`,
                  gridRow: `${rowStart} / span ${rowSpan}`,
                  position: sticky ? "sticky" : undefined, left: sticky ? RUNDOWN_TIME_WIDTH + pinnedIndex * RUNDOWN_LANE_MIN_WIDTH : undefined,
                  zIndex: sticky ? 9 : 4, minWidth: 0, margin: 2, padding: "7px 8px",
                  border: `1px solid ${selected ? "#2463d4" : tone.border}`, borderRadius: 7,
                  outline: selected ? "2px solid rgba(36,99,212,.24)" : undefined,
                  background: entryColors[entryKey(selection)] ?? tone.bg, boxShadow: "0 2px 6px rgba(24,42,42,.06)",
                  cursor: editMode ? "move" : "default", userSelect: "none",
                }} className={styles.rundownEntry}>
                  <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", fontSize: 9, whiteSpace: "nowrap", color: "var(--ink)" }}>
                    {it.title}
                  </b>
                  <small style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {dur} min
                  </small>
                  {it.participants.length > 0 && rowSpan >= 2 && (
                    <p style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.participants.map(p => p.name).join(" · ")}
                    </p>
                  )}
                  {editMode && <>
                    <i className={`${styles.resizeHandle} ${styles.resizeHandleTop}`} title="拖动调整开始时间" onPointerDown={event => beginResize(event, selection, "start", it.startTime!, it.endTime!)} onPointerMove={moveResize} onPointerUp={event => void finishResize(event)} />
                    <i className={`${styles.resizeHandle} ${styles.resizeHandleBottom}`} title="拖动调整结束时间" onPointerDown={event => beginResize(event, selection, "end", it.startTime!, it.endTime!)} onPointerMove={moveResize} onPointerUp={event => void finishResize(event)} />
                  </>}
                </article>
              );
            });})}
            {/* 任务 cell（绑定 event 未绑 schedule；task 草绿调，点击进任务详情） */}
            {visibleTasks.flatMap(t => {
              const selection: RundownEntrySelection = { kind: "task", id: t.id };
              const indexes = laneIndexes(selection, lanes.map((column, index) => taskMatchesColumn(t, column) ? index : -1).filter(index => index >= 0));
              return placements(indexes).map((pl, pi) => {
              const { rowStart, rowSpan } = rowOf(t.effectiveStartTime!, t.effectiveEndTime!);
              const tone = ITEM_TONE.task;
              const dur = minutesOfIso(t.effectiveEndTime!) - minutesOfIso(t.effectiveStartTime!);
              const laneIndex = pl.start - 2;
              const pinnedIndex = lanes.slice(0, laneIndex).filter(column => column.pinned).length;
              const sticky = pl.span === 1 && lanes[laneIndex]?.pinned;
              const selected = selectedEntry?.kind === "task" && selectedEntry.id === t.id;
              return (
                <Link
                  key={`task-${t.id}-${pi}`}
                  href={`/production/${productionId}/tasks/${t.id}`}
                  draggable={editMode}
                  onDragStart={event => { if (!editMode) { event.preventDefault(); return; } dragEntryRef.current = { ...selection, duration: dur }; event.dataTransfer.effectAllowed = "move"; }}
                  onClick={event => { if (editMode) { event.preventDefault(); setSelectedEntry(selection); } }}
                  onDoubleClick={event => { if (editMode) { event.preventDefault(); setSelectedEntry(selection); } }}
                  title={editMode ? "拖动到新的人员组或时间；拖动上下边缘调整长度；点击编辑" : `前往任务：${t.title}`}
                  style={{
                    gridColumn: `${pl.start} / span ${pl.span}`,
                    gridRow: `${rowStart} / span ${rowSpan}`,
                    position: sticky ? "sticky" : undefined, left: sticky ? RUNDOWN_TIME_WIDTH + pinnedIndex * RUNDOWN_LANE_MIN_WIDTH : undefined,
                    zIndex: sticky ? 9 : 4, minWidth: 0, margin: 2, padding: "7px 8px",
                    border: `1px ${selected ? "solid" : "dashed"} ${selected ? "#2463d4" : tone.border}`, borderRadius: 7,
                    outline: selected ? "2px solid rgba(36,99,212,.24)" : undefined,
                    background: entryColors[entryKey(selection)] ?? tone.bg, boxShadow: "0 2px 6px rgba(24,42,42,.06)",
                    textDecoration: "none", display: "block", cursor: editMode ? "move" : "pointer", userSelect: "none",
                  }}
                  className={styles.rundownEntry}
                >
                  <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", fontSize: 9, whiteSpace: "nowrap", color: "var(--ink)" }}>
                    任务 · {t.title || "（未命名）"}
                  </b>
                  <small style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {[TASK_STATUS_LABELS[t.status] ?? t.status, `${dur} min`].join(" · ")}
                  </small>
                  {t.assignees.length > 0 && rowSpan >= 2 && (
                    <p style={{ display: "block", margin: "3px 0 0", overflow: "hidden", color: "var(--muted)", fontSize: 7, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.assignees.map(a => a.name).join(" · ")}
                    </p>
                  )}
                  {editMode && <>
                    <i className={`${styles.resizeHandle} ${styles.resizeHandleTop}`} title="拖动调整开始时间" onPointerDown={event => beginResize(event, selection, "start", t.effectiveStartTime!, t.effectiveEndTime!)} onPointerMove={moveResize} onPointerUp={event => void finishResize(event)} />
                    <i className={`${styles.resizeHandle} ${styles.resizeHandleBottom}`} title="拖动调整结束时间" onPointerDown={event => beginResize(event, selection, "end", t.effectiveStartTime!, t.effectiveEndTime!)} onPointerMove={moveResize} onPointerUp={event => void finishResize(event)} />
                  </>}
                </Link>
              );
            });})}
          </div>
        </div>
      )}
      {(editingColumn || (editMode && selectedEntry && (selectedItem || selectedTask))) && (
        <button
          type="button"
          className={styles.editorBackdrop}
          aria-label="关闭编辑面板"
          onClick={() => { setEditingColumnId(null); setSelectedEntry(null); }}
        />
      )}
      {editingColumn && <RundownColumnEditor
        column={editingColumn}
        departments={departments}
        members={members}
        roles={roleOptions}
        onChange={patch => updateColumn(editingColumn.id, patch)}
        onRename={name => void saveColumnGroup(editingColumn, { name })}
        onToggleValue={(key, value) => toggleColumnValue(editingColumn.id, key, value)}
        onToggleRole={role => toggleColumnRole(editingColumn.id, role)}
        onDelete={() => removeColumn(editingColumn.id)}
        onClose={() => setEditingColumnId(null)}
      />}
      {editMode && selectedEntry && (selectedItem || selectedTask) && (
        <RundownEntryEditor
          key={entryKey(selectedEntry)}
          selection={selectedEntry}
          item={selectedItem}
          task={selectedTask}
          lanes={lanes.filter(lane => lane.kind === "people")}
          laneIds={selectedLaneIds}
          color={entryColors[entryKey(selectedEntry)] ?? (selectedItem ? (ITEM_TONE[selectedItem.itemType] ?? ITEM_TONE.custom).bg : ITEM_TONE.task.bg)}
          onSave={draft => saveSelectedEntry(selectedEntry, draft)}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </section>
  );
}
