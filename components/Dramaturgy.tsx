"use client";

import { useState, useEffect, useCallback } from "react";
import ScenesManager from "./ScenesManager";
import styles from "./my-pages.module.css";
import SceneTableView, { getDefaultViewConfig, normalizeTableViewConfig, type TableViewConfigData } from "./SceneTableView";
import TableColumnSettings from "./TableColumnSettings";
import TableViewSelector, { type SavedView } from "./TableViewSelector";
import { BASE_PATH } from "@/lib/base-path";
import type { MarkerProjection } from "@/lib/script-marker-domain";

type SceneViewMode = "list" | "table";

type Props = {
  productionId: string;
  productionName: string;
  versionId: string | null;
  initialScenes: MarkerProjection[];
  canEdit: boolean;
  initialSceneId?: string;
};

function isUpdatingResponse(payload: unknown): payload is { status: "updating" } {
  return typeof payload === "object" && payload !== null && "status" in payload && payload.status === "updating";
}

export default function Dramaturgy({
  productionId,
  productionName,
  versionId,
  initialScenes,
  canEdit,
  initialSceneId,
}: Props) {
  const [scenes, setScenes] = useState<MarkerProjection[]>(initialScenes);
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
    if (viewsLoaded) return;
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scene-table-views`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.views && data.views.length > 0) {
          setSavedViews(data.views);
          const defaultView = data.views.find((v: SavedView) => v.isDefault) ?? data.views[0];
          if (defaultView && defaultView.config) {
            setTableConfig(normalizeTableViewConfig(defaultView.config));
            setActiveViewId(defaultView.id);
          }
        }
      } catch (e) {
        console.error("Failed to load table views", e);
      } finally {
        setViewsLoaded(true);
      }
    })();
  }, [productionId, viewsLoaded]);

  const handleUpdateScene = useCallback(async (sceneId: string, name: string) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(versionId ? { name, versionId } : { name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
    setScenes((prev) => prev.map((s) => s.id === sceneId ? { ...s, name } : s));
  }, [productionId, versionId]);

  const handlePatchMeta = useCallback(async (sceneId: string, fields: Partial<Pick<MarkerProjection, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">>) => {
    const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(versionId ? { ...fields, versionId } : fields),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
    setScenes((prev) => prev.map((s) => s.id === sceneId ? { ...s, ...fields } : s));
  }, [productionId, versionId]);

  const handleConfigChange = (config: TableViewConfigData) => setTableConfig(config);

  const handleSelectView = (view: SavedView) => {
    setTableConfig(normalizeTableViewConfig(view.config));
    setActiveViewId(view.id || null);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-[var(--paper)]">
      {/* ── Frozen toolbar ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-[var(--surface)] border-b border-[var(--line)] shrink-0">
        <div className={styles.viewToggle}>
          <button aria-selected={sceneViewMode === "list"} onClick={() => setSceneViewMode("list")}>
            ☰ 列表
          </button>
          <button aria-selected={sceneViewMode === "table"} onClick={() => setSceneViewMode("table")}>
            ⊞ 表格
          </button>
        </div>

        {sceneViewMode === "table" && (
          <div className="ml-auto flex items-center gap-2">
            <TableViewSelector
              productionId={productionId}
              views={savedViews}
              activeViewId={activeViewId}
              currentConfig={tableConfig}
              onSelectView={handleSelectView}
              onViewsChange={setSavedViews}
            />
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setShowColumnSettings((v) => !v)}
                className="text-[11px] font-bold px-3 py-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--surface-2)] transition-colors cursor-pointer"
              >
                ⚙ 列设置
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

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto p-5">
        {sceneViewMode === "list" ? (
          <ScenesManager
            key={versionId ?? ""}
            productionId={productionId}
            productionName={productionName}
            initialScenes={scenes}
            canEdit={canEdit}
            versionId={versionId}
            initialExpandedId={initialSceneId}
            embedded
          />
        ) : (
          <SceneTableView
            key={versionId ?? ""}
            productionId={productionId}
            scenes={scenes}
            canEdit={canEdit}
            versionId={versionId}
            viewConfig={tableConfig}
            onViewConfigChange={handleConfigChange}
            onUpdateScene={handleUpdateScene}
            onPatchMeta={handlePatchMeta}
          />
        )}
      </div>
    </div>
  );
}
