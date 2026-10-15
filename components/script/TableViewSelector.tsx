"use client";

import { useAnchoredMenu } from "../shell/ProductionTopMenu";
import { useState, useRef, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { BASE_PATH } from "@/lib/base-path";
import ChevronIcon from "@/components/ui/ChevronIcon";
import styles from "./TableViewSelector.module.css";

export type SavedView = {
  id: string;
  name: string;
  isDefault: boolean;
  config: unknown;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  productionId: string;
  views: SavedView[];
  activeViewId: string | null;
  currentConfig: unknown;
  onSelectView: (view: SavedView) => void;
  onViewsChange: (views: SavedView[]) => void;
  loading?: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
};

export default function TableViewSelector({
  productionId, views, activeViewId, currentConfig, onSelectView, onViewsChange,
  loading = false, loadError, onRetryLoad,
}: Props) {
  const [open, setOpen] = useState(false);
  const position = useAnchoredMenu<HTMLButtonElement>(open, "bottom");
  const panelId = useId();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const activeView = views.find((view) => view.id === activeViewId);
  const busy = pending !== null;
  const unavailable = busy || loading || !!loadError;
  const saveReason = loading ? "正在读取视图" : loadError ? "请先重试读取视图"
    : busy ? "正在处理，请稍候" : !activeView ? "请先另存新视图，再保存当前视图" : undefined;

  useEffect(() => {
    if (!open) return;
    function dismiss(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (position.anchorRef.current?.contains(event.target) || position.menuRef.current?.contains(event.target)) return;
      setOpen(false);
      setConfirmDelete(null);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      setConfirmDelete(null);
      position.anchorRef.current?.focus();
    }
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open, position.anchorRef, position.menuRef]);

  // 所有写操作共用同步锁，连续点击或 Enter 不会在 React 更新前发出第二次请求。
  async function mutate(label: string, work: () => Promise<void>) {
    if (pendingRef.current || loading || loadError) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(`${label}成功`);
    } catch (cause) {
      setError(`${label}失败：${cause instanceof Error ? cause.message : "请重试"}`);
      setOpen(true);
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  async function request(path: string, method: string, body?: unknown) {
    const response = await fetch(`${BASE_PATH}/api/production/${productionId}/scene-table-views${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => { throw new Error("服务器返回异常，请重试"); });
    if (!response.ok) throw new Error(data.error || "操作失败，请重试");
    return data;
  }

  function saveCurrent() {
    if (!activeView) return;
    void mutate("保存当前视图", async () => {
      const saved = await request(`/${activeView.id}`, "PATCH", { config: currentConfig }) as SavedView;
      onViewsChange(views.map((view) => view.id === saved.id ? saved : view));
    });
  }

  function createView() {
    if (!newName.trim()) return;
    void mutate("另存新视图", async () => {
      const saved = await request("", "POST", {
        name: newName.trim(), config: currentConfig, isDefault: views.length === 0,
      }) as SavedView;
      onViewsChange([...views, saved]);
      onSelectView(saved);
      setNewName("");
      setCreating(false);
    });
  }

  function setDefault(viewId: string) {
    void mutate("设为默认", async () => {
      await request(`/${viewId}/default`, "PATCH");
      onViewsChange(views.map((view) => ({ ...view, isDefault: view.id === viewId })));
    });
  }

  function deleteView(viewId: string) {
    void mutate("删除视图", async () => {
      await request(`/${viewId}`, "DELETE");
      onViewsChange(views.filter((view) => view.id !== viewId));
      if (activeViewId === viewId) {
        // 沿用删除选中视图后的行为：取消选中，保留当前表格配置。
        onSelectView({ id: "", name: "", isDefault: false, config: currentConfig, createdAt: "", updatedAt: "" });
      }
      setConfirmDelete(null);
    });
  }

  return (
    <>
      <button ref={position.anchorRef} type="button" aria-expanded={open} aria-controls={panelId}
        aria-haspopup="dialog" title={activeView?.name || "默认视图"}
        onClick={() => setOpen((value) => !value)} className={styles.trigger}>
        <span className={styles.triggerName}>{activeView?.name || "默认视图"}</span>
        <ChevronIcon size={12} className="shrink-0 text-zinc-400" />
      </button>
      {open && createPortal(
        <div ref={position.menuRef} id={panelId} role="dialog" aria-label="保存视图选择器"
          data-production-overflow-menu-child="true" style={position.style} className={styles.panel}>
          <div className={styles.actions}>
            <button type="button" aria-disabled={unavailable} title={unavailable ? saveReason : undefined}
              onClick={() => { if (!unavailable) { setCreating(true); setNotice(null); } }} className={styles.action}>
              另存新视图
            </button>
            <button type="button" aria-disabled={!!saveReason} title={saveReason}
              onClick={() => { if (!saveReason) saveCurrent(); }} className={styles.action}>
              {pending === "保存当前视图" ? "保存中…" : "保存当前视图"}
            </button>
            {!activeView && !loading && !loadError && <p className={styles.hint}>请先另存新视图</p>}
            {creating && <form className={styles.create} onSubmit={(event) => { event.preventDefault(); createView(); }}>
              <input autoFocus aria-label="视图名称" placeholder="视图名称" value={newName}
                onChange={(event) => setNewName(event.target.value)} disabled={unavailable} />
              <button type="submit" disabled={unavailable || !newName.trim()}>{pending === "另存新视图" ? "保存中…" : "保存"}</button>
              <button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button>
            </form>}
            {(error || loadError) && <p role="alert" className={styles.error}>{error || loadError}</p>}
            {loadError && <button type="button" className={styles.action} onClick={onRetryLoad}>重试读取视图</button>}
            <div role="status" className={styles.hint}>{pending ? `${pending}中…` : notice}</div>
          </div>
          <div className={styles.list} aria-label="已保存视图">
            {loading ? <p className={styles.hint}>正在读取视图…</p>
              : !loadError && views.length === 0 ? <p className={styles.hint}>暂无保存的视图</p> : null}
            {views.map((view) => <div key={view.id} className={styles.row} data-selected={view.id === activeViewId}>
              <button type="button" title={view.name} aria-pressed={view.id === activeViewId} disabled={unavailable}
                className={styles.select} onClick={() => {
                  onSelectView(view); setOpen(false); setNotice(null); setError(null); setConfirmDelete(null);
                }}>
                <span className={styles.check}>{view.id === activeViewId ? "✓" : ""}</span>
                <span className={styles.name}>{view.name}</span>
                {view.isDefault && <span className={styles.defaultBadge}>默认</span>}
              </button>
              {!view.isDefault && <button type="button" disabled={unavailable} className={styles.rowAction}
                title="设为默认" aria-label={`将 ${view.name} 设为默认`} onClick={() => setDefault(view.id)}>★</button>}
              <button type="button" disabled={unavailable} className={styles.rowAction}
                title={confirmDelete === view.id ? "确认删除视图" : "删除视图"}
                aria-label={`${confirmDelete === view.id ? "确认删除" : "删除"} ${view.name}`}
                onClick={() => confirmDelete === view.id ? deleteView(view.id) : setConfirmDelete(view.id)}>
                {confirmDelete === view.id ? "确认" : "×"}
              </button>
            </div>)}
          </div>
        </div>, document.body,
      )}
    </>
  );
}
