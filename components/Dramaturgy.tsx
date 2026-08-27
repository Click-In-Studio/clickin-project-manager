"use client";

import { useState, useEffect, useCallback } from "react";
import ScenesManager from "./ScenesManager";
import SceneTableView, { getDefaultViewConfig, normalizeTableViewConfig, type TableViewConfigData } from "./SceneTableView";
import TableColumnSettings from "./TableColumnSettings";
import TableViewSelector, { type SavedView } from "./TableViewSelector";
import ChevronIcon from "./ChevronIcon";
import { BASE_PATH } from "@/lib/base-path";
import type { MarkerProjection } from "@/lib/script-marker-domain";
import ProductionTopMenu, {
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS,
  PRODUCTION_TOOLBAR_STAGE,
  ProductionOverflowSubmenuButton,
  ProductionTopMenuDivider,
  PRODUCTION_TOP_MENU_RIGHT_CLASS,
  useAnchoredMenu,
  useProductionToolbar,
} from "./ProductionTopMenu";
import ListTableViewToggle, { ListTableViewToggleOverflow } from "./ListTableViewToggle";
import type { SceneFieldPerms } from "@/lib/scene-field-perms-shared";
import { DramaturgyWorkspaceHeading } from "./DramaturgyWorkspaceTabs";

type SceneViewMode = "list" | "table";

type Props = {
  productionId: string;
  productionName: string;
  versionId: string | null;
  initialScenes: MarkerProjection[];
  canEdit: boolean;
  /** 逐字段编辑权限（scene 的每个字段各有一把钥匙，见 lib/scene-field-perms） */
  fieldPerms: SceneFieldPerms;
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
  fieldPerms,
  initialSceneId,
}: Props) {
  const { stage: toolbarStage, closeOverflow, overflowOpen } = useProductionToolbar();
  const [scenes, setScenes] = useState<MarkerProjection[]>(initialScenes);
  const [sceneViewMode, setSceneViewMode] = useState<SceneViewMode>("list");

  useEffect(() => {
    setSceneViewMode(window.innerWidth > 1920 ? "table" : "list");
  }, []);

  const [tableConfig, setTableConfig] = useState<TableViewConfigData>(getDefaultViewConfig());
  const [showColumnSettings, setShowColumnSettings] = useState(false);
  const [storedColumnSettingsOpen, setStoredColumnSettingsOpen] = useState(false);
  const [mobileCreatingView, setMobileCreatingView] = useState(false);
  const [mobileNewName, setMobileNewName] = useState("");
  const [mobileSaving, setMobileSaving] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [viewsLoaded, setViewsLoaded] = useState(false);
  const storedColumnSettingsPosition = useAnchoredMenu<HTMLButtonElement>(
    toolbarStage >= PRODUCTION_TOOLBAR_STAGE.secondaryStored && sceneViewMode === "table" && overflowOpen && storedColumnSettingsOpen,
    "left",
    "columns",
  );

  useEffect(() => {
    if (!overflowOpen || toolbarStage < PRODUCTION_TOOLBAR_STAGE.secondaryStored || sceneViewMode !== "table") {
      setStoredColumnSettingsOpen(false);
    }
  }, [overflowOpen, toolbarStage, sceneViewMode]);

  useEffect(() => {
    if (!storedColumnSettingsOpen) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (storedColumnSettingsPosition.anchorRef.current?.contains(target)) return;
      if (storedColumnSettingsPosition.menuRef.current?.contains(target)) return;
      setStoredColumnSettingsOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [storedColumnSettingsOpen, storedColumnSettingsPosition.anchorRef, storedColumnSettingsPosition.menuRef]);

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
      closeOverflow();
    } catch (e) {
      console.error(e);
    } finally {
      setMobileSaving(false);
    }
  };

  const secondaryOverflow = toolbarStage >= PRODUCTION_TOOLBAR_STAGE.secondaryStored && sceneViewMode === "table" ? (
    <>
      {savedViews.length > 0 && (
        <>
          <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">
            切换视图
          </div>
          {savedViews.map((view) => (
            <button
              key={view.id}
              type="button"
              onClick={() => { handleSelectView(view); closeOverflow(); }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)] ${
                activeViewId === view.id ? "font-bold text-[var(--ink)]" : "text-[var(--muted)]"
              }`}
            >
              <span className="w-3 text-[9px] text-[var(--script)]">{activeViewId === view.id ? "✓" : ""}</span>
              <span className="min-w-0 flex-1 truncate">{view.name}</span>
              {view.isDefault && <span className="text-[9px] font-normal text-[var(--muted)]">默认</span>}
            </button>
          ))}
        </>
      )}
      <div className="border-t border-[var(--line)] py-1">
        {activeViewId && (
          <button
            type="button"
            onClick={() => { void handleMobileSaveView(); }}
            disabled={mobileSaving}
            className="w-full px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            {mobileSaving ? "保存中…" : "保存到当前视图"}
          </button>
        )}
        {mobileCreatingView ? (
          <div className="flex gap-1.5 px-3 py-2">
            <input
              autoFocus
              value={mobileNewName}
              onChange={(event) => setMobileNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleMobileCreateView();
                if (event.key === "Escape") { setMobileCreatingView(false); setMobileNewName(""); }
              }}
              placeholder="视图名称"
              className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-xs text-[var(--ink)] outline-none"
            />
            <button
              type="button"
              onClick={() => { void handleMobileCreateView(); }}
              disabled={mobileSaving || !mobileNewName.trim()}
              className="rounded-md border-0 bg-[var(--ink)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-40"
            >
              存
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setMobileCreatingView(true)}
            className="w-full px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--surface-2)]"
          >
            另存为新视图
          </button>
        )}
      </div>
      <div className="border-t border-[var(--line)] py-1">
        <ProductionOverflowSubmenuButton
          menuId="columns"
          label="列设置"
          expanded={storedColumnSettingsOpen}
          onToggle={(anchor) => {
            storedColumnSettingsPosition.anchorRef.current = anchor;
            setStoredColumnSettingsOpen((open) => !open);
          }}
        />
      </div>
    </>
  ) : null;
  const primaryOverflow = toolbarStage >= PRODUCTION_TOOLBAR_STAGE.primaryStored ? (
    <ListTableViewToggleOverflow value={sceneViewMode} onChange={setSceneViewMode} />
  ) : null;
  const toolbarOverflow = secondaryOverflow || primaryOverflow ? (
    <>
      {secondaryOverflow}
      {primaryOverflow}
    </>
  ) : null;

  return (
    <div className={PRODUCTION_PAGE_SCROLL_ROOT_CLASS}>
      {/* ── Frozen toolbar ── */}
      <ProductionTopMenu overflow={toolbarOverflow}>
        <DramaturgyWorkspaceHeading
          productionId={productionId}
          productionName={productionName}
          active="overview"
        />
        <ProductionTopMenuDivider />
        <ListTableViewToggle value={sceneViewMode} onChange={setSceneViewMode} />

        {sceneViewMode === "table" && (
          <>
          <div className={toolbarStage >= PRODUCTION_TOOLBAR_STAGE.secondaryStored ? "hidden" : `${PRODUCTION_TOP_MENU_RIGHT_CLASS} ml-auto flex items-center`}>
            {/* Desktop: inline controls */}
            <div className="flex items-center gap-2">
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
                  className="flex items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
                >
                  列设置 <ChevronIcon size={12} className="opacity-50" />
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
          </div>
          {toolbarStage >= PRODUCTION_TOOLBAR_STAGE.secondaryStored && overflowOpen && storedColumnSettingsOpen && (
            <TableColumnSettings
              config={tableConfig}
              onChange={handleConfigChange}
              onClose={() => setStoredColumnSettingsOpen(false)}
              nestedFromOverflow
              nestedMenuRef={storedColumnSettingsPosition.menuRef}
              nestedMenuStyle={storedColumnSettingsPosition.style}
            />
          )}
          </>
        )}
      </ProductionTopMenu>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto" style={{ padding: "24px clamp(18px, 3vw, 52px) 60px" }}>
        {sceneViewMode === "list" ? (
          <ScenesManager
            key={versionId ?? ""}
            productionId={productionId}
            productionName={productionName}
            initialScenes={scenes}
            canEdit={canEdit}
            fieldPerms={fieldPerms}
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
            fieldPerms={fieldPerms}
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
