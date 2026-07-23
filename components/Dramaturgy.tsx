"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import ScenesManager from "./ScenesManager";
import CharactersManager from "./CharactersManager";
import VersionSelector from "./VersionSelector";
import SceneTableView, { getDefaultViewConfig, type TableViewConfigData } from "./SceneTableView";
import TableColumnSettings from "./TableColumnSettings";
import TableViewSelector, { type SavedView } from "./TableViewSelector";
import { BASE_PATH } from "@/lib/base-path";
import type { SceneDetail, CharacterDetail, Version } from "@/lib/db";

type Tab = "scenes" | "characters";
type SceneViewMode = "list" | "table";

type Props = {
  productionId: string;
  productionName: string;
  versions: Version[];
  versionId: string | null;
  initialScenes: SceneDetail[];
  rehearsalMarks: Record<string, string[]>;
  initialCharacters: CharacterDetail[];
  canEdit: boolean;
  canImport?: boolean;
  initialSceneId?: string;
  initialCharacterId?: string;
};

function isUpdatingResponse(payload: unknown): payload is { status: "updating" } {
  return typeof payload === "object" && payload !== null && "status" in payload && payload.status === "updating";
}

export default function Dramaturgy({
  productionId,
  productionName,
  versions,
  versionId: initialVersionId,
  initialScenes,
  rehearsalMarks: initialRehearsalMarks,
  initialCharacters,
  canEdit,
  canImport,
  initialSceneId,
  initialCharacterId,
}: Props) {
  const [tab, setTab] = useState<Tab>(
    initialCharacterId && !initialSceneId ? "characters" : "scenes"
  );
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(initialVersionId);
  const [scenes, setScenes] = useState<SceneDetail[]>(initialScenes);
  const [rehearsalMarks, setRehearsalMarks] = useState<Record<string, string[]>>(initialRehearsalMarks);
  const [characters, setCharacters] = useState<CharacterDetail[]>(initialCharacters);

  const [sceneViewMode, setSceneViewMode] = useState<SceneViewMode>("list");

  useEffect(() => {
    setSceneViewMode(window.innerWidth > 1920 ? "table" : "list");
  }, []);
  const [tableConfig, setTableConfig] = useState<TableViewConfigData>(getDefaultViewConfig());
  const [showColumnSettings, setShowColumnSettings] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [viewsLoaded, setViewsLoaded] = useState(false);

  useEffect(() => {
    if (tab !== "scenes" || viewsLoaded) return;
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scene-table-views`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.views && data.views.length > 0) {
          setSavedViews(data.views);
          const defaultView = data.views.find((v: SavedView) => v.isDefault) ?? data.views[0];
          if (defaultView && defaultView.config) {
            setTableConfig(defaultView.config as TableViewConfigData);
            setActiveViewId(defaultView.id);
          }
        }
      } catch (e) {
        console.error("Failed to load table views", e);
      } finally {
        setViewsLoaded(true);
      }
    })();
  }, [tab, productionId, viewsLoaded]);

  const handleVersionChange = async (versionId: string) => {
    const [scenePayload, charsData] = await Promise.all([
      fetch(`${BASE_PATH}/api/production/${productionId}/scenes?versionId=${versionId}&includeRehearsalMarks=1`).then(r => r.json()),
      fetch(`${BASE_PATH}/api/production/${productionId}/characters?versionId=${versionId}`).then(r => r.json()),
    ]);
    if (isUpdatingResponse(scenePayload) || isUpdatingResponse(charsData)) {
      return;
    }
    setScenes(scenePayload.scenes);
    setCharacters(charsData);
    setRehearsalMarks(scenePayload.rehearsalMarks);
    setCurrentVersionId(versionId);
  };

  const currentVersion = versions.find(v => v.id === currentVersionId);
  const effectiveCanEdit = canEdit && (!currentVersion || currentVersion.status === "editing" || currentVersion.status === "committed");

  const handleUpdateScene = useCallback(async (sceneId: string, name: string) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { name, versionId: currentVersionId } : { name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
    setScenes((prev) => prev.map((s) => s.id === sceneId ? { ...s, name } : s));
  }, [productionId, currentVersionId]);

  const handlePatchMeta = useCallback(async (sceneId: string, fields: Partial<Pick<SceneDetail, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">>) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentVersionId ? { ...fields, versionId: currentVersionId } : fields),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
    setScenes((prev) => prev.map((s) => s.id === sceneId ? { ...s, ...fields } : s));
  }, [productionId, currentVersionId]);

  const handleConfigChange = (config: TableViewConfigData) => {
    setTableConfig(config);
  };

  const handleSelectView = (view: SavedView) => {
    if (view.id && view.config) {
      setTableConfig(view.config as TableViewConfigData);
      setActiveViewId(view.id);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className={`mx-auto ${sceneViewMode === "table" && tab === "scenes" ? "max-w-full px-2 xl:max-w-none" : "max-w-2xl"}`}>
        <div className="mb-6 flex items-center justify-between">
          <Link href={`/production/${productionId}`} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回
          </Link>
          <div className="text-right flex flex-col items-end gap-1">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Dramaturgy</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
            <div className="flex items-center justify-end gap-1.5">
              {versions.length > 0 && (
                <VersionSelector
                  productionId={productionId}
                  versions={versions}
                  currentVersionId={currentVersionId}
                  onChange={handleVersionChange}
                />
              )}
              <span className="shrink-0 rounded bg-zinc-200 px-2 py-0.5 text-[11px] text-zinc-500">
                {effectiveCanEdit ? "可编辑" : "只读"}
              </span>
            </div>
            {canImport && tab === "scenes" && (
              <Link href={`/production/${productionId}/import-script`} className="text-xs text-blue-500 hover:underline">
                导入
              </Link>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-xl bg-white p-1 shadow-sm">
          {(["scenes", "characters"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
                tab === t
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:text-zinc-600"
              }`}
            >
              {t === "scenes" ? "章节" : "角色"}
            </button>
          ))}
        </div>

        {tab === "scenes" ? (
          <>
            {/* Scene view mode toggle + view selector */}
            <div className="mb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-1 rounded-lg bg-white p-0.5 shadow-sm w-fit">
                <button
                  onClick={() => setSceneViewMode("list")}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    sceneViewMode === "list"
                      ? "bg-zinc-100 text-zinc-700"
                      : "text-zinc-400 hover:text-zinc-600"
                  }`}
                >
                  ☰ 列表
                </button>
                <button
                  onClick={() => setSceneViewMode("table")}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    sceneViewMode === "table"
                      ? "bg-zinc-100 text-zinc-700"
                      : "text-zinc-400 hover:text-zinc-600"
                  }`}
                >
                  ⊞ 表格
                </button>
              </div>

              {sceneViewMode === "table" && (
                <div className="flex items-center gap-2 flex-wrap">
                  <TableViewSelector
                    productionId={productionId}
                    views={savedViews}
                    activeViewId={activeViewId}
                    currentConfig={tableConfig}
                    onSelectView={handleSelectView}
                    onViewsChange={setSavedViews}
                    onNewView={() => {}}
                  />
                  <div className="relative">
                    <button
                      onClick={() => setShowColumnSettings((v) => !v)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded-lg transition-colors"
                    >
                      ⚙️ 列设置
                    </button>
                    {showColumnSettings && (
                      <TableColumnSettings
                        config={tableConfig}
                        onChange={handleConfigChange}
                        onClose={() => setShowColumnSettings(false)}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            {sceneViewMode === "list" ? (
              <ScenesManager
                key={currentVersionId ?? ""}
                productionId={productionId}
                productionName={productionName}
                initialScenes={scenes}
                rehearsalMarks={rehearsalMarks}
                canEdit={effectiveCanEdit}
                versionId={currentVersionId}
                initialExpandedId={initialSceneId}
                embedded
              />
            ) : (
              <SceneTableView
                key={currentVersionId ?? ""}
                productionId={productionId}
                scenes={scenes}
                rehearsalMarks={rehearsalMarks}
                canEdit={effectiveCanEdit}
                versionId={currentVersionId}
                viewConfig={tableConfig}
                onViewConfigChange={handleConfigChange}
                onUpdateScene={handleUpdateScene}
                onPatchMeta={handlePatchMeta}
              />
            )}
          </>
        ) : (
          <CharactersManager
            key={currentVersionId ?? ""}
            productionId={productionId}
            productionName={productionName}
            initialCharacters={characters}
            canEdit={effectiveCanEdit}
            initialExpandedId={initialCharacterId}
            embedded
          />
        )}
      </div>
    </div>
  );
}
