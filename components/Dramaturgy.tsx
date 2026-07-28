"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  const [showMobileViewMenu, setShowMobileViewMenu] = useState(false);
  const [mobileCreatingView, setMobileCreatingView] = useState(false);
  const [mobileNewName, setMobileNewName] = useState("");
  const [mobileSaving, setMobileSaving] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
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

  const handleMobileSaveView = async () => {
    if (!activeViewId || mobileSaving) return;
    setMobileSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scene-table-views/${activeViewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: tableConfig }),
      });
      if (!res.ok) throw new Error("保存失败");
      setSavedViews((prev) => prev.map((v) => v.id === activeViewId ? { ...v, config: tableConfig } : v));
    } catch (e) {
      console.error(e);
    } finally {
      setMobileSaving(false);
    }
  };

  const handleMobileCreateView = async () => {
    if (!mobileNewName.trim() || mobileSaving) return;
    setMobileSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scene-table-views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: mobileNewName.trim(), config: tableConfig, isDefault: savedViews.length === 0 }),
      });
      if (!res.ok) throw new Error("创建失败");
      const data = await res.json() as SavedView;
      setSavedViews((prev) => [...prev, data]);
      handleSelectView(data);
      setMobileNewName("");
      setMobileCreatingView(false);
      setShowMobileViewMenu(false);
    } catch (e) {
      console.error(e);
    } finally {
      setMobileSaving(false);
    }
  };

  useEffect(() => {
    if (!showMobileViewMenu) return;
    const dismiss = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setShowMobileViewMenu(false);
        setMobileCreatingView(false);
        setMobileNewName("");
      }
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [showMobileViewMenu]);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-[var(--paper)]">
      {/* ── Frozen toolbar ── */}
      <div className="flex items-center gap-3 px-4 h-14 bg-[var(--surface)] border-b border-[var(--line)] shadow-sm shrink-0">
        <div className="flex shrink-0 flex-col mr-1" style={{ lineHeight: 1.2 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--script)", whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
            {productionName}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>构作</span>
        </div>
        <div className="shrink-0" style={{ width: 1, height: 28, background: "var(--line)" }} />
        <div className={styles.viewToggle}>
          <button aria-selected={sceneViewMode === "list"} onClick={() => setSceneViewMode("list")}>
            ☰ 列表
          </button>
          <button aria-selected={sceneViewMode === "table"} onClick={() => setSceneViewMode("table")}>
            ⊞ 表格
          </button>
        </div>

        {sceneViewMode === "table" && (
          <>
            {/* Desktop: inline controls */}
            <div className="ml-auto hidden sm:flex items-center gap-2">
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

            {/* Mobile: ⋮ menu */}
            <div ref={mobileMenuRef} className="ml-auto sm:hidden" style={{ position: "relative" }}>
              <button
                onClick={() => setShowMobileViewMenu((v) => !v)}
                className="flex items-center justify-center w-8 h-8 rounded-lg border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--surface-2)] transition-colors cursor-pointer text-base font-bold"
                title="视图设置"
              >
                ⋮
              </button>
              {showMobileViewMenu && (
                <div style={{
                  position: "absolute", right: 0, top: "calc(100% + 6px)",
                  minWidth: 180, borderRadius: 12,
                  border: "1px solid var(--line)", background: "var(--surface)",
                  boxShadow: "0 4px 20px rgba(24,42,42,.12)", zIndex: 30,
                  overflow: "hidden",
                }}>
                  {/* Saved views list */}
                  {savedViews.length > 0 && (
                    <>
                      <div style={{ padding: "8px 14px 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)" }}>
                        切换视图
                      </div>
                      {savedViews.map((v) => (
                        <button
                          key={v.id}
                          onClick={() => { handleSelectView(v); setShowMobileViewMenu(false); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8, width: "100%",
                            padding: "7px 14px", textAlign: "left", cursor: "pointer",
                            fontSize: 13, fontWeight: activeViewId === v.id ? 700 : 400,
                            color: activeViewId === v.id ? "var(--ink)" : "var(--muted)",
                            background: "transparent", border: "none",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                        >
                          <span style={{ width: 12, fontSize: 9, color: "var(--script)" }}>{activeViewId === v.id ? "✓" : ""}</span>
                          {v.name}
                          {v.isDefault && <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--muted)" }}>默认</span>}
                        </button>
                      ))}
                    </>
                  )}
                  {/* Save / create */}
                  <div style={{ borderTop: "1px solid var(--line)", padding: "6px 0" }}>
                    {activeViewId && (
                      <button
                        onClick={() => { void handleMobileSaveView(); }}
                        disabled={mobileSaving}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, width: "100%",
                          padding: "7px 14px", textAlign: "left", cursor: "pointer",
                          fontSize: 13, fontWeight: 400, color: "var(--muted)",
                          background: "transparent", border: "none", opacity: mobileSaving ? 0.5 : 1,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                      >
                        {mobileSaving ? "保存中…" : "↑ 保存到当前视图"}
                      </button>
                    )}
                    {mobileCreatingView ? (
                      <div style={{ padding: "6px 14px", display: "flex", gap: 6 }}>
                        <input
                          autoFocus
                          value={mobileNewName}
                          onChange={(e) => setMobileNewName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { void handleMobileCreateView(); }
                            if (e.key === "Escape") { setMobileCreatingView(false); setMobileNewName(""); }
                          }}
                          placeholder="视图名称"
                          style={{
                            flex: 1, fontSize: 12, padding: "4px 8px",
                            border: "1px solid var(--line)", borderRadius: 6,
                            outline: "none", background: "var(--paper)", color: "var(--ink)",
                          }}
                        />
                        <button
                          onClick={() => { void handleMobileCreateView(); }}
                          disabled={mobileSaving || !mobileNewName.trim()}
                          style={{
                            padding: "4px 10px", fontSize: 12, fontWeight: 600,
                            borderRadius: 6, border: "none", cursor: "pointer",
                            background: "var(--ink)", color: "#fff", opacity: (!mobileNewName.trim() || mobileSaving) ? 0.4 : 1,
                          }}
                        >
                          存
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setMobileCreatingView(true)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, width: "100%",
                          padding: "7px 14px", textAlign: "left", cursor: "pointer",
                          fontSize: 13, fontWeight: 400, color: "var(--muted)",
                          background: "transparent", border: "none",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                      >
                        + 另存为新视图
                      </button>
                    )}
                  </div>
                  {/* Column settings */}
                  <div style={{ borderTop: "1px solid var(--line)", padding: "6px 0" }}>
                    <button
                      onClick={() => { setShowMobileViewMenu(false); setShowColumnSettings((v) => !v); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        padding: "7px 14px", textAlign: "left", cursor: "pointer",
                        fontSize: 13, fontWeight: 400, color: "var(--muted)",
                        background: "transparent", border: "none",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                    >
                      ⚙ 列设置
                    </button>
                  </div>
                </div>
              )}
              {showColumnSettings && (
                <TableColumnSettings
                  config={tableConfig}
                  onChange={handleConfigChange}
                  onClose={() => setShowColumnSettings(false)}
                />
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto" style={{ padding: "24px clamp(18px, 3vw, 52px) 60px" }}>
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
