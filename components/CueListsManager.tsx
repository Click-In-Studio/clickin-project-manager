"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import styles from "./my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";
import type { CueList, CueListTemplate } from "@/lib/cue-list-types";
import { TEMPLATE_ABBR_HINTS } from "@/lib/cue-list-types";
import type { CueListPermissionRow } from "@/lib/cue-list-types";
import type { MemberWithRoles } from "@/lib/db";
import CueListDetail from "./CueListDetail";

type Filter = "all" | "created" | "editable" | "readonly";

const FILTER_LABELS: Record<Filter, string> = {
  all: "全部",
  created: "由我创建",
  editable: "我可编辑",
  readonly: "仅可查看",
};

type DrawerData = {
  cueList: CueList;
  permissions: CueListPermissionRow[];
  canEdit: boolean;
  canManage: boolean;
  roleEditorUserIds: string[];
};

type Props = {
  productionId: string;
  initialCueLists: CueList[];
  canCreate: boolean;
  availableTemplates: CueListTemplate[];
  myUserId: string;
  editableIds: string[];
  members: MemberWithRoles[];
};

function CreateModal({
  productionId,
  availableTemplates,
  onCreated,
  onCancel,
}: {
  productionId: string;
  availableTemplates: CueListTemplate[];
  onCreated: (lists: CueList[]) => void;
  onCancel: () => void;
}) {
  const initTemplate = availableTemplates[0]?.key ?? "";
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(initTemplate);
  const [abbr, setAbbrState] = useState(TEMPLATE_ABBR_HINTS[initTemplate] ?? "");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const prevTemplateRef = useRef(initTemplate);
  useEffect(() => {
    const prevHint = TEMPLATE_ABBR_HINTS[prevTemplateRef.current] ?? "";
    const newHint = TEMPLATE_ABBR_HINTS[template] ?? "";
    if (abbr === "" || abbr === prevHint) setAbbrState(newHint);
    prevTemplateRef.current = template;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  function handleAbbrChange(v: string) { setAbbrState(v.toUpperCase()); }

  const submit = async () => {
    if (!name.trim()) { setError("名称不能为空"); return; }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cuelists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), notes: notes.trim(), template: template || undefined, abbr: abbr.trim() || undefined }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        setError(j.error ?? "创建失败");
        return;
      }
      onCreated(await res.json() as CueList[]);
    } finally { setSaving(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", borderRadius: 6, border: "1px solid var(--line)", padding: "6px 9px",
    fontSize: 12, outline: "none", background: "var(--surface)", color: "var(--ink)",
    opacity: saving ? 0.5 : 1,
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onCancel}
        style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.25)", zIndex: 60 }}
      />
      {/* Modal */}
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: "min(460px, calc(100vw - 32px))", zIndex: 61,
        background: "var(--surface)", borderRadius: 16, border: "1px solid var(--line)",
        boxShadow: "0 12px 40px rgba(24,42,42,.18)", padding: "24px",
        display: "flex", flexDirection: "column", gap: 16,
      }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>新建 Cue 表</p>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>名称</label>
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
            disabled={saving} autoFocus placeholder="Cue表名称" style={inputStyle}
          />
        </div>

        {availableTemplates.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>类型</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {availableTemplates.map((t) => (
                <button
                  key={t.key} onClick={() => setTemplate(t.key)} disabled={saving}
                  style={{
                    borderRadius: 7, padding: "4px 12px", fontSize: 12, border: "none", cursor: saving ? "default" : "pointer",
                    background: template === t.key ? "var(--ink)" : "var(--surface-2)",
                    color: template === t.key ? "#fff" : "var(--muted)",
                    transition: "background .1s, color .1s",
                  }}
                >
                  {t.label}
                </button>
              ))}
              <button
                onClick={() => setTemplate("")} disabled={saving}
                style={{
                  borderRadius: 7, padding: "4px 12px", fontSize: 12, border: "none", cursor: saving ? "default" : "pointer",
                  background: template === "" ? "var(--ink)" : "var(--surface-2)",
                  color: template === "" ? "#fff" : "var(--muted)",
                  transition: "background .1s, color .1s",
                }}
              >
                自定义
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
              简称 <span style={{ fontWeight: 400, textTransform: "none" }}>可选 · 同项目唯一</span>
            </label>
            <input
              value={abbr} onChange={(e) => handleAbbrChange(e.target.value)}
              disabled={saving} placeholder={template ? (TEMPLATE_ABBR_HINTS[template] ?? "如 XQ") : "如 XQ"}
              maxLength={8} style={{ ...inputStyle, fontFamily: "monospace" }}
            />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>备注</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={saving} placeholder="—" style={inputStyle} />
          </div>
        </div>

        {error && <p style={{ fontSize: 11, color: "#dc2626" }}>{error}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel} disabled={saving}
            style={{ borderRadius: 8, border: "1px solid var(--line)", padding: "7px 16px", fontSize: 12, cursor: "pointer", background: "transparent", color: "var(--muted)" }}
          >
            取消
          </button>
          <button
            onClick={submit} disabled={saving}
            style={{ borderRadius: 8, border: "none", padding: "7px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "var(--ink)", color: "#fff", opacity: saving ? 0.5 : 1 }}
          >
            {saving ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </>
  );
}

export default function CueListsManager({
  productionId,
  initialCueLists,
  canCreate,
  availableTemplates,
  myUserId,
  editableIds,
  members,
}: Props) {
  const [lists, setLists] = useState(initialCueLists);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  // Drawer state
  const [drawerListId, setDrawerListId] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<DrawerData | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const editableSet = useMemo(() => new Set(editableIds), [editableIds]);

  const filtered = useMemo(() => {
    if (filter === "all") return lists;
    if (filter === "created") return lists.filter(cl => cl.createdBy === myUserId);
    if (filter === "editable") return lists.filter(cl => editableSet.has(cl.id) && cl.createdBy !== myUserId);
    return lists.filter(cl => !editableSet.has(cl.id));
  }, [lists, filter, myUserId, editableSet]);

  const openDrawer = async (listId: string) => {
    setDrawerListId(listId);
    setDrawerLoading(true);
    setDrawerData(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/cuelists/${listId}`);
      if (res.ok) setDrawerData(await res.json() as DrawerData);
    } finally { setDrawerLoading(false); }
  };

  const closeDrawer = () => { setDrawerListId(null); setDrawerData(null); };

  // Close drawer on Escape
  useEffect(() => {
    if (!drawerListId && !creating) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { closeDrawer(); setCreating(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [drawerListId, creating]);

  return (
    <div style={{ padding: "28px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      {/* Page header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>
            Cue
          </p>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em" }}>Cue 表</h1>
        </div>
        {canCreate && (
          <button
            onClick={() => setCreating(true)}
            style={{ border: 0, borderRadius: 9, padding: "7px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "var(--ink)", color: "#fff" }}
          >
            + 新建
          </button>
        )}
      </div>

      <div style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "20px 24px", minHeight: "calc(100vh - 280px)" }}>
      {/* Filter tab bar */}
      <div className={styles.tabBar} style={{ marginBottom: 20 }}>
        {(Object.keys(FILTER_LABELS) as Filter[]).map(f => (
          <button key={f} aria-selected={filter === f} onClick={() => setFilter(f)}>
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* Card grid */}
      {filtered.length === 0 ? (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <p style={{ fontSize: 13, color: "var(--muted)" }}>{lists.length === 0 ? "暂无 Cue 表" : "没有符合条件的 Cue 表"}</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {filtered.map((cl) => (
            <button
              key={cl.id}
              onClick={() => openDrawer(cl.id)}
              style={{
                display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                borderRadius: 12, border: "1px solid var(--line)",
                background: "var(--surface-2)", padding: "16px 18px",
                transition: "box-shadow .15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 2px 10px rgba(24,42,42,.08)"; }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = ""; }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {cl.name}
                    </p>
                    {cl.abbr && (
                      <span style={{ flexShrink: 0, borderRadius: 5, background: "var(--surface-2)", padding: "1px 6px", fontSize: 10, fontFamily: "monospace", fontWeight: 700, color: "var(--muted)" }}>
                        {cl.abbr}
                      </span>
                    )}
                  </div>
                  {cl.template && (
                    <p style={{ fontSize: 10, color: "var(--muted)", marginBottom: 2 }}>{cl.template}</p>
                  )}
                  {cl.notes && (
                    <p style={{ fontSize: 11, color: "var(--muted)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {cl.notes}
                    </p>
                  )}
                </div>
                <p style={{ fontSize: 10, color: "var(--muted)", flexShrink: 0, marginTop: 2 }}>{cl.createdByName}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      </div>

      {/* Create modal */}
      {creating && (
        <CreateModal
          productionId={productionId}
          availableTemplates={availableTemplates}
          onCreated={(newLists) => { setLists(newLists); setCreating(false); }}
          onCancel={() => setCreating(false)}
        />
      )}

      {/* Detail modal */}
      {drawerListId && (
        <>
          <div
            onClick={closeDrawer}
            style={{ position: "fixed", inset: 0, background: "rgba(24,42,42,.25)", zIndex: 60 }}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
            width: "min(560px, calc(100vw - 32px))", maxHeight: "calc(100vh - 80px)",
            background: "var(--surface)", borderRadius: 16, border: "1px solid var(--line)",
            boxShadow: "0 12px 40px rgba(24,42,42,.18)", zIndex: 61,
            display: "flex", flexDirection: "column", overflow: "hidden",
          }}>
            {drawerLoading ? (
              <div style={{ padding: 48, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
                加载中…
              </div>
            ) : drawerData ? (
              <CueListDetail
                productionId={productionId}
                cueList={drawerData.cueList}
                permissions={drawerData.permissions}
                members={members}
                roleEditorUserIds={drawerData.roleEditorUserIds}
                canEdit={drawerData.canEdit}
                canManage={drawerData.canManage}
                myUserId={myUserId}
                onUpdated={(fields) => {
                  setLists(prev => prev.map(cl => cl.id === drawerListId ? { ...cl, ...fields } : cl));
                  setDrawerData(prev => prev ? { ...prev, cueList: { ...prev.cueList, ...fields } } : null);
                }}
                onDeleted={() => {
                  setLists(prev => prev.filter(cl => cl.id !== drawerListId));
                  closeDrawer();
                }}
                onClose={closeDrawer}
              />
            ) : (
              <div style={{ padding: 48, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
                加载失败
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
