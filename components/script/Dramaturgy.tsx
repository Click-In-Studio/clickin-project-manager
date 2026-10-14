"use client";

import { useState, useEffect, useCallback } from "react";
import ScenesManager from "./ScenesManager";
import SceneTableView, { getDefaultViewConfig, normalizeTableViewConfig, type TableViewConfigData } from "./SceneTableView";
import TableColumnSettings from "./TableColumnSettings";
import TableViewSelector, { type SavedView } from "./TableViewSelector";
import ChevronIcon from "../ui/ChevronIcon";
import { BASE_PATH } from "@/lib/base-path";
import { useAgentMutation } from "@/lib/agent/agent-mutations";
import type { MarkerProjection } from "@/lib/script/script-marker-domain";
import ProductionTopMenu, {
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS,
  ProductionToolbarBlock,
  useAnchoredMenu,
} from "../shell/ProductionTopMenu";
import ListTableViewToggle from "./ListTableViewToggle";
import type { SceneFieldPerms } from "@/lib/script/scene-field-perms-shared";
import { DramaturgyWorkspaceHeading } from "./DramaturgyWorkspaceTabs";
import PageSkeleton from "@/components/ui/PageSkeleton";
import { useListTableViewPreference } from "./use-list-table-view-preference";
import DramaturgyModePicker from "./DramaturgyModePicker";
import { useDramaturgyWorkspaceMode } from "./use-dramaturgy-workspace-mode";

type Props = {
  productionId: string;
  productionName: string;
  versionId: string | null;
  initialScenes: MarkerProjection[];
  openingChapterMarkerId: string | null;
  canEdit: boolean;
  /** 逐字段编辑权限（scene 的每个字段各有一把钥匙，见 lib/script/scene-field-perms） */
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
  openingChapterMarkerId,
  canEdit,
  fieldPerms,
  initialSceneId,
}: Props) {
  const [scenes, setScenes] = useState<MarkerProjection[]>(initialScenes);
  const [sceneViewMode, setSceneViewMode] = useListTableViewPreference("dramaturgy");
  const workspaceMode = useDramaturgyWorkspaceMode(productionId, canEdit);
  const contentEditable = workspaceMode.mode === "edit";
  const trackWorkspaceWrite = workspaceMode.trackWrite;

  // AI 写工具改了场次（lib/agent/runtime/tools.ts 的 scene mutates）→ 重拉一次。列表模式
  // 的 ScenesManager 自己订阅 markers SSE 会刷，但表格模式用的是这里的 scenes state。
  useAgentMutation({ scope: "scene", productionId }, () => {
    const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
    void fetch(`${BASE_PATH}/api/production/${productionId}/scenes${query}`)
      .then(async (res) => { if (res.ok) setScenes(await res.json() as MarkerProjection[]); })
      .catch(() => {});
  });

  const [tableConfig, setTableConfig] = useState<TableViewConfigData>(getDefaultViewConfig());
  const [showColumnSettings, setShowColumnSettings] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [viewsLoaded, setViewsLoaded] = useState(false);
  const [viewLoadError, setViewLoadError] = useState<string | null>(null);
  const columnsPosition = useAnchoredMenu<HTMLButtonElement>(showColumnSettings, "bottom");
  useEffect(() => {
    if (!showColumnSettings) return;
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Node && !columnsPosition.anchorRef.current?.contains(event.target)
        && !columnsPosition.menuRef.current?.contains(event.target)) setShowColumnSettings(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [showColumnSettings, columnsPosition.anchorRef, columnsPosition.menuRef]);

  useEffect(() => {
    if (viewsLoaded) return;
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scene-table-views`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "读取视图失败，请重试");
        setViewLoadError(null);
        if (data.views && data.views.length > 0) {
          setSavedViews(data.views);
          const defaultView = data.views.find((v: SavedView) => v.isDefault) ?? data.views[0];
          if (defaultView && defaultView.config) {
            setTableConfig(normalizeTableViewConfig(defaultView.config));
            setActiveViewId(defaultView.id);
          }
        }
      } catch (e) {
        setViewLoadError(e instanceof Error ? e.message : "读取视图失败，请重试");
      } finally {
        setViewsLoaded(true);
      }
    })();
  }, [productionId, viewsLoaded]);

  const handleUpdateScene = useCallback((sceneId: string, name: string) => trackWorkspaceWrite((async () => {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(versionId ? { name, versionId } : { name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
      setScenes((prev) => prev.map((s) => s.id === sceneId ? { ...s, name } : s));
    })()), [productionId, trackWorkspaceWrite, versionId]);

  const handlePatchMeta = useCallback((sceneId: string, fields: Partial<Pick<MarkerProjection, "synopsis" | "actionLine" | "music" | "stageNotes" | "expectedDuration">>) => trackWorkspaceWrite((async () => {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/scenes/${sceneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(versionId ? { ...fields, versionId } : fields),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || isUpdatingResponse(data)) throw new Error(data.error ?? "更新失败");
      setScenes((prev) => prev.map((s) => s.id === sceneId ? { ...s, ...fields } : s));
    })()), [productionId, trackWorkspaceWrite, versionId]);

  const handleConfigChange = (config: TableViewConfigData) => setTableConfig(config);

  const handleSelectView = (view: SavedView) => {
    setTableConfig(normalizeTableViewConfig(view.config));
    setActiveViewId(view.id || null);
  };

  return (
    <div className={PRODUCTION_PAGE_SCROLL_ROOT_CLASS}>
      {/* ── Frozen toolbar ── */}
      <ProductionTopMenu progressive>
        <DramaturgyWorkspaceHeading productionId={productionId} active="overview" />
        <ProductionToolbarBlock id="mode" priority={30}>
          <DramaturgyModePicker mode={workspaceMode.mode} canEdit={canEdit}
            switching={workspaceMode.switching} error={workspaceMode.error}
            onChange={(mode) => { void workspaceMode.requestMode(mode); }} />
        </ProductionToolbarBlock>
        {sceneViewMode !== null && (
          <ProductionToolbarBlock id="view" priority={40}>
            <ListTableViewToggle value={sceneViewMode} onChange={setSceneViewMode} />
          </ProductionToolbarBlock>
        )}
        {sceneViewMode === "table" && (
          <>
            <ProductionToolbarBlock id="saved-view" priority={10}>
              <TableViewSelector productionId={productionId} views={savedViews}
                activeViewId={activeViewId} currentConfig={tableConfig}
                onSelectView={handleSelectView} onViewsChange={setSavedViews}
                loading={!viewsLoaded} loadError={viewLoadError}
                onRetryLoad={() => { setViewLoadError(null); setViewsLoaded(false); }} />
            </ProductionToolbarBlock>
            <ProductionToolbarBlock id="columns" priority={20}>
              <button ref={columnsPosition.anchorRef} aria-expanded={showColumnSettings}
                onClick={() => setShowColumnSettings((open) => !open)}
                className="flex h-8 items-center gap-0.5 whitespace-nowrap rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-100">
                列设置 <ChevronIcon size={12} className="opacity-50" />
              </button>
              {showColumnSettings && <TableColumnSettings config={tableConfig} onChange={handleConfigChange}
                onClose={() => setShowColumnSettings(false)} nestedFromOverflow
                nestedMenuRef={columnsPosition.menuRef} nestedMenuStyle={columnsPosition.style} />}
            </ProductionToolbarBlock>
          </>
        )}
      </ProductionTopMenu>

      {/* ── Scrollable content ── */}
      <div
        className="flex-1 overflow-y-auto"
        style={sceneViewMode === null ? undefined : { padding: "24px clamp(18px, 3vw, 52px) 60px" }}
      >
        {sceneViewMode === null ? <PageSkeleton instant /> : sceneViewMode === "list" ? (
          <ScenesManager
            key={versionId ?? ""}
            productionId={productionId}
            productionName={productionName}
            initialScenes={scenes}
            openingChapterMarkerId={openingChapterMarkerId}
            canEdit={contentEditable}
            fieldPerms={fieldPerms}
            trackWrite={trackWorkspaceWrite}
            versionId={versionId}
            initialExpandedId={initialSceneId}
            embedded
          />
        ) : (
          <SceneTableView
            key={versionId ?? ""}
            productionId={productionId}
            scenes={scenes}
            canEdit={contentEditable}
            fieldPerms={fieldPerms}
            viewConfig={tableConfig}
            onViewConfigChange={handleConfigChange}
            onUpdateScene={handleUpdateScene}
            onPatchMeta={handlePatchMeta}
            versionId={versionId}
            openingChapterMarkerId={openingChapterMarkerId}
            onScenesChange={setScenes}
            trackWrite={trackWorkspaceWrite}
          />
        )}
      </div>
    </div>
  );
}
