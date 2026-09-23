"use client";

import React from "react";
import Link from "next/link";
import ChevronIcon from "@/components/ui/ChevronIcon";
import type { Scene } from "@/lib/script/script-types";
import SceneRow from "./SceneRow";
import { anchoredManagementPanelStyle } from "./constants";

export default function ScenePanel({
  scenes,
  productionId,
  onAdd,
  onUpdate,
  onRemove,
  open,
  onOpenChange,
  onNavigate,
  triggerClassName,
  nestedFromMore = false,
  nestedMenuRef,
  nestedMenuStyle,
  label = "章节",
}: {
  scenes: Scene[];
  productionId: string;
  onAdd: (parentId?: string, target?: { insertAfterSceneId?: string; insertBeforeSceneId?: string }) => void;
  onUpdate: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNavigate?: () => void;
  triggerClassName?: string;
  nestedFromMore?: boolean;
  nestedMenuRef?: React.RefObject<HTMLDivElement | null>;
  nestedMenuStyle?: React.CSSProperties;
  label?: string;
}) {
  return (
    <div className="relative shrink-0">
      <button
        data-script-toolbar-menu-trigger="scene"
        onClick={() => onOpenChange(!open)}
        className={triggerClassName ?? "flex items-center gap-0.5 rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"}
      >
        {label} <ChevronIcon size={12} className="opacity-50" />
      </button>
      {open && (
        <div
          data-script-toolbar-menu-panel="scene"
          data-production-overflow-menu-child={nestedFromMore ? "true" : undefined}
          ref={nestedFromMore ? nestedMenuRef : undefined}
          className={`${nestedFromMore ? "" : "absolute right-0 top-full mt-2.5"} z-40 flex w-72 flex-col rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-xl`}
          style={nestedFromMore ? anchoredManagementPanelStyle(nestedMenuStyle ?? {}) : { maxHeight: "min(28rem, calc(100vh - 8rem))" }}
        >
          <div className="shrink-0 flex items-center justify-between border-b border-zinc-100 px-3 py-2">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">章节管理</span>
            <div className="flex items-center gap-2">
              <Link href={`/production/${productionId}/dramaturgy`} onNavigate={onNavigate} className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors">
                构作 →
              </Link>
            </div>
          </div>
          <div className="overflow-y-auto p-3">
            {scenes.length === 0 ? (
              <p className="mb-2 text-center text-xs text-zinc-300">暂无章节</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-400">
                    <th className="pb-1 pr-2 font-medium">编号</th>
                    <th className="pb-1 font-medium">名称</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {scenes.map((s, index) => {
                    const isSubScene = s.parentId !== null;
                    const nextScene = scenes[index + 1];
                    const isChapterEnd = !nextScene || nextScene.parentId === null;
                    const chapterId = isSubScene ? s.parentId : s.id;
                    return (
                      <React.Fragment key={s.id}>
                        <SceneRow
                          scene={s}
                          onUpdate={onUpdate}
                          onRemove={onRemove}
                          canRemove
                          indent={isSubScene}
                        />
                        {isChapterEnd && chapterId && (
                          <tr>
                            <td colSpan={3} className="pt-0 pb-1 pl-5">
                              <button
                                onClick={() => onAdd(chapterId, nextScene ? { insertBeforeSceneId: nextScene.id } : undefined)}
                                className="text-[11px] text-zinc-300 hover:text-zinc-500 transition-colors"
                              >
                                + 添加段落
                              </button>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="shrink-0 border-t border-zinc-100 p-3">
            <button
              onClick={() => onAdd(undefined, scenes.length > 0 ? { insertAfterSceneId: scenes[scenes.length - 1].id } : undefined)}
              className="w-full rounded-lg border border-dashed border-zinc-200 py-1.5 text-sm text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-600"
            >
              + 添加章节
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
