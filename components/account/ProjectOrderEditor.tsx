"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import type { MyProductionEntry } from "@/lib/production/production-db";

export type RelativePlacement = { anchorId: string; side: "before" | "after" };

export function moveProjectRelative<T extends { id: string }>(
  items: T[], movingId: string, place: RelativePlacement,
): T[] {
  if (movingId === place.anchorId) return items;
  const moving = items.find(item => item.id === movingId);
  if (!moving) return items;
  const rest = items.filter(item => item.id !== movingId);
  const anchorIndex = rest.findIndex(item => item.id === place.anchorId);
  if (anchorIndex < 0) return items;
  const slot = place.side === "before" ? anchorIndex : anchorIndex + 1;
  const next = [...rest];
  next.splice(slot, 0, moving);
  return next;
}

type DragState = {
  pointerId: number;
  movingId: string;
  original: MyProductionEntry[];
  place: RelativePlacement | null;
};

export default function ProjectOrderEditor({
  projects,
  onOrderChange,
}: {
  projects: MyProductionEntry[];
  onOrderChange: (projects: MyProductionEntry[]) => void;
}) {
  const router = useRouter();
  const [ordered, setOrdered] = useState(projects);
  const orderedRef = useRef(projects);
  const dragRef = useRef<DragState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("拖动手柄调整顺序，也可以聚焦手柄后按上下方向键");

  const replaceOrdered = (next: MyProductionEntry[]) => {
    orderedRef.current = next;
    setOrdered(next);
  };

  async function persist(movingId: string, place: RelativePlacement, before: MyProductionEntry[]) {
    const next = moveProjectRelative(before, movingId, place);
    if (next === before || next.every((item, index) => item.id === before[index]?.id)) return;
    replaceOrdered(next);
    setSaving(true);
    setMessage("正在保存顺序…");
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productionId: movingId, place }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "保存失败");
      onOrderChange(next);
      setMessage("顺序已保存");
      router.refresh();
    } catch (error) {
      replaceOrdered(before);
      setMessage(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>, movingId: string) {
    if (saving) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, movingId, original: orderedRef.current, place: null };
    setDraggingId(movingId);
  }

  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-project-order-id]");
    const anchorId = row?.dataset.projectOrderId;
    if (!row || !anchorId || anchorId === drag.movingId) return;
    const side = event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
      ? "before" : "after";
    const place = { anchorId, side } satisfies RelativePlacement;
    drag.place = place;
    replaceOrdered(moveProjectRelative(orderedRef.current, drag.movingId, place));
  }

  function pointerEnd(event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingId(null);
    if (cancelled || !drag.place) {
      replaceOrdered(drag.original);
      return;
    }
    void persist(drag.movingId, drag.place, drag.original);
  }

  function moveByKeyboard(index: number, direction: -1 | 1) {
    if (saving) return;
    const anchor = orderedRef.current[index + direction];
    const moving = orderedRef.current[index];
    if (!anchor || !moving) return;
    const place: RelativePlacement = {
      anchorId: anchor.id,
      side: direction < 0 ? "before" : "after",
    };
    void persist(moving.id, place, orderedRef.current);
  }

  return (
    <section aria-label="调整项目顺序">
      <p style={{ margin: "0 0 14px", color: "var(--muted)", fontSize: 12 }}>
        拖动左侧手柄排列进行中的项目。这个顺序只对你生效。
      </p>
      <div style={{ display: "grid", gap: 8 }}>
        {ordered.map((project, index) => (
          <div
            key={project.id}
            data-project-order-id={project.id}
            style={{
              minHeight: 62, display: "flex", alignItems: "center", gap: 12,
              padding: "10px 14px", border: "1px solid var(--line)", borderRadius: 10,
              background: "var(--surface)", opacity: draggingId === project.id ? 0.62 : 1,
              boxShadow: draggingId === project.id ? "0 8px 24px rgba(24,42,42,.12)" : "none",
            }}
          >
            <button
              type="button"
              aria-label={`拖动《${project.name}》；上下方向键也可调整`}
              aria-disabled={saving || undefined}
              onPointerDown={event => pointerDown(event, project.id)}
              onPointerMove={pointerMove}
              onPointerUp={event => pointerEnd(event)}
              onPointerCancel={event => pointerEnd(event, true)}
              onKeyDown={event => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                moveByKeyboard(index, event.key === "ArrowUp" ? -1 : 1);
              }}
              style={{
                width: 36, height: 36, flexShrink: 0, border: "1px solid var(--line)",
                borderRadius: 8, background: "var(--paper)", color: "var(--muted)",
                cursor: saving ? "wait" : draggingId === project.id ? "grabbing" : "grab",
                touchAction: "none", fontSize: 18, lineHeight: 1,
              }}
            >
              ⠿
            </button>
            <span style={{ minWidth: 0, flex: 1 }}>
              <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14 }}>
                {project.name}
              </b>
              <small style={{ color: "var(--muted)", fontSize: 10 }}>
                {project.roles[0] ?? (project.isOwner ? "项目所有者" : "项目成员")}
              </small>
            </span>
            <span aria-hidden style={{ color: "var(--muted)", fontSize: 11 }}>{index + 1}</span>
          </div>
        ))}
      </div>
      <p role="status" aria-live="polite" style={{ minHeight: 18, margin: "10px 2px 0", color: "var(--muted)", fontSize: 11 }}>
        {message}
      </p>
    </section>
  );
}
