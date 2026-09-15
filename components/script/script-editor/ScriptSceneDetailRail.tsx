"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MountPointAssets from "@/components/assets/MountPointAssets";
import DurationInput from "@/components/ui/DurationInput";
import type { SceneDetail } from "@/lib/db";
import { formatDuration, parseDuration } from "@/lib/duration";
import { getChapterDurationDisplay } from "@/lib/ops/scene-duration";
import type { SceneMetaFields } from "@/lib/script/script-scene-details";
import ScriptSceneMetaField from "./ScriptSceneMetaField";
import { SCRIPT_SCENE_DETAIL_MODE_BUTTON_EXTRA_INSET_REM, SCRIPT_SCENE_DETAIL_CAPTION_BG_HEIGHT_REM, SCRIPT_SCENE_DETAIL_MODE_LABEL } from "./constants";

export default function ScriptSceneDetailRail({
  scene,
  scenes,
  productionId,
  versionId,
  canEdit,
  controlledEditMode,
  showHeader = true,
  isDeleteConfirmHighlighted = false,
  scrollbarOffsetPx,
  onUpdateIdentity,
  onPatchMeta,
}: {
  scene: SceneDetail | null;
  scenes: SceneDetail[];
  productionId: string;
  versionId: string | null;
  canEdit: boolean;
  controlledEditMode?: boolean;
  showHeader?: boolean;
  isDeleteConfirmHighlighted?: boolean;
  scrollbarOffsetPx: number;
  onUpdateIdentity: (id: string, name: string) => void;
  onPatchMeta: (id: string, fields: Partial<SceneMetaFields>) => Promise<void>;
}) {
  const [nameDraft, setNameDraft] = useState(scene?.name ?? "");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [internalEditMode, setInternalEditMode] = useState(false);
  const editMode = controlledEditMode ?? internalEditMode;
  const railRef = useRef<HTMLDivElement | null>(null);
  const sectionCanEdit = canEdit && editMode;
  const chapterDurationDisplay = useMemo(
    () => scene?.parentId === null
      ? getChapterDurationDisplay(scenes.filter((child) => child.parentId === scene.id))
      : null,
    [scene?.id, scene?.parentId, scenes]
  );
  const expectedDuration = scene?.expectedDuration ?? "";
  const expectedDurationSeconds = useMemo(
    () => expectedDuration ? parseDuration(expectedDuration) : null,
    [expectedDuration]
  );
  const chapterDurationHasMissing = chapterDurationDisplay?.hasMissingDuration ?? false;
  const durationText = scene
    ? (chapterDurationHasMissing && !sectionCanEdit
      ? "—"
      : chapterDurationDisplay?.text ?? (formatDuration(expectedDurationSeconds) || "—"))
    : "—";
  const sceneCaptionNumber = scene ? scene.number.trim() || "—" : "";
  const sceneCaptionName = scene ? scene.name.trim() || "未命名" : "";
  const sceneCaptionText = scene
    ? `【${sceneCaptionNumber}】${sceneCaptionName}`
    : "";

  useEffect(() => {
    setNameDraft(scene?.name ?? "");
  }, [scene?.id, scene?.name]);
  useEffect(() => {
    setInternalEditMode(false);
  }, [scene?.id]);
  useEffect(() => {
    if (!editMode || controlledEditMode !== undefined) return;
    const handlePointerDown = (event: PointerEvent) => {
      const rail = railRef.current;
      if (!rail || rail.contains(event.target as Node)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && rail.contains(active)) active.blur();
      window.setTimeout(() => setInternalEditMode(false), 0);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [controlledEditMode, editMode]);

  const commitIdentity = async () => {
    if (!scene) return;
    const name = nameDraft.trim();
    if (name === scene.name) return;
    setSavingIdentity(true);
    try {
      onUpdateIdentity(scene.id, name);
    } finally {
      setSavingIdentity(false);
    }
  };
  const renderDurationField = () => {
    if (!scene) return null;
    return (
      <div className="group space-y-1.5">
        <label className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase transition-colors group-hover:text-zinc-600">预期时长</label>
        {chapterDurationDisplay ? (
          <p className="min-h-[1.75rem] whitespace-pre-wrap rounded-lg border border-zinc-200 bg-transparent px-2.5 py-2 text-xs leading-relaxed text-zinc-700 transition-colors group-hover:border-zinc-300 group-hover:text-zinc-950">
            {chapterDurationHasMissing && !sectionCanEdit
              ? <span className="italic text-zinc-400">—</span>
              : chapterDurationDisplay.text || <span className="italic text-zinc-400">—</span>}
          </p>
        ) : (
          <DurationInput
            value={expectedDurationSeconds}
            canEdit={sectionCanEdit}
            onSave={(seconds) => onPatchMeta(scene.id, { expectedDuration: seconds != null ? String(seconds) : "" })}
            className="!min-h-[1.75rem] !rounded-lg !border !border-zinc-200 !bg-transparent !px-2.5 !py-2 !text-xs !text-zinc-700 hover:!border-zinc-300 hover:!bg-transparent hover:!text-zinc-950"
          />
        )}
      </div>
    );
  };

  return (
    <div
      ref={railRef}
      data-script-scene-detail="true"
      className="panel-scrollbar-area group/scene-detail box-border flex h-full min-h-0 w-full flex-col rounded-lg px-3 pt-3 text-left"
      style={{
        background: isDeleteConfirmHighlighted
          ? "#fee2e2"
          : `linear-gradient(to bottom, rgb(255, 255, 255) 0, rgb(255, 255, 255) ${SCRIPT_SCENE_DETAIL_CAPTION_BG_HEIGHT_REM}rem, rgba(255, 255, 255, ${sectionCanEdit ? "1" : "0.5"}) ${SCRIPT_SCENE_DETAIL_CAPTION_BG_HEIGHT_REM}rem, rgba(255, 255, 255, ${sectionCanEdit ? "1" : "0.5"}) 100%)`,
      }}
    >
      {showHeader && <div
        className="mb-3 flex shrink-0 items-center justify-between gap-2"
        style={{
          marginRight: `calc(-0.75rem - ${scrollbarOffsetPx}px)`,
          paddingRight: `calc(${scrollbarOffsetPx}px + 8px + ${SCRIPT_SCENE_DETAIL_MODE_BUTTON_EXTRA_INSET_REM}rem)`,
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {sectionCanEdit ? (
            <p className="shrink-0 text-xs font-bold tracking-widest text-zinc-500 uppercase">章节详情</p>
          ) : scene ? (
            <>
              <p className="min-w-0 flex-1 truncate text-xs text-zinc-600" title={sceneCaptionText}>
                <span className="font-bold">【{sceneCaptionNumber}】</span>
                <span>{sceneCaptionName}</span>
              </p>
              <div className="h-4 w-px shrink-0 bg-zinc-100" />
              <p className="shrink-0 whitespace-nowrap text-xs text-zinc-600">
                <span className="font-bold">预期时长：</span>
                <span className="font-normal">{durationText}</span>
              </p>
            </>
          ) : (
            <p className="shrink-0 text-xs font-bold tracking-widest text-zinc-500 uppercase">章节详情</p>
          )}
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setInternalEditMode((value) => !value)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
              editMode
                ? "bg-zinc-700 text-white opacity-100 hover:bg-zinc-600"
                : "pointer-events-none bg-[#637ca1] text-white opacity-0 hover:bg-[#91a8ca] group-hover/scene-detail:pointer-events-auto group-hover/scene-detail:opacity-100"
            }`}
          >
            {editMode ? SCRIPT_SCENE_DETAIL_MODE_LABEL.edit : SCRIPT_SCENE_DETAIL_MODE_LABEL.view}
          </button>
        ) : (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">只读</span>
        )}
      </div>}
      {!scene ? (
        <div className="flex flex-1 items-center justify-center text-center text-xs leading-relaxed text-zinc-500">
          滚动或选择目录中的章节
        </div>
      ) : (
        <div
          className="panel-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain"
          style={{
            marginRight: `calc(-0.75rem - ${scrollbarOffsetPx}px)`,
            paddingRight: `calc(${scrollbarOffsetPx}px + 8px)`,
          }}
        >
          {sectionCanEdit && (
            <>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
                <div className="group space-y-1.5">
                  <label className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase transition-colors group-hover:text-zinc-600">编号</label>
                  <div className="w-full rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-2 text-xs font-semibold tabular-nums text-zinc-500">
                    {scene.number || "—"}
                  </div>
                </div>
                <div className="group space-y-1.5">
                  <label className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase transition-colors group-hover:text-zinc-600">名称</label>
                  <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitIdentity}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    disabled={savingIdentity}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 hover:border-zinc-300 hover:text-zinc-950 focus:border-zinc-400 disabled:opacity-50"
                    placeholder="未命名"
                  />
                </div>
              </div>
              {renderDurationField()}
            </>
          )}
          <ScriptSceneMetaField label="简介" value={scene.synopsis} multiline canEdit={sectionCanEdit} onSave={(value) => onPatchMeta(scene.id, { synopsis: value })} />
          <ScriptSceneMetaField label="行动线" value={scene.actionLine} multiline canEdit={sectionCanEdit} onSave={(value) => onPatchMeta(scene.id, { actionLine: value })} />
          <ScriptSceneMetaField label="音乐" value={scene.music} multiline canEdit={sectionCanEdit} onSave={(value) => onPatchMeta(scene.id, { music: value })} />
          <ScriptSceneMetaField label="舞台呈现" value={scene.stageNotes} multiline canEdit={sectionCanEdit} onSave={(value) => onPatchMeta(scene.id, { stageNotes: value })} />
          <div className="pt-3">
            <MountPointAssets
              productionId={productionId}
              mountType="scene"
              mountId={scene.id}
              label={`${scene.number}${scene.name ? ` ${scene.name}` : ""}`}
              canEdit={sectionCanEdit}
              display="compact"
            />
          </div>
        </div>
      )}
    </div>
  );
}
