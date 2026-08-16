"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import Link from "next/link";
import styles from "./my-pages.module.css";
import { BASE_PATH } from "@/lib/base-path";
import type { CueList, CueListGrant, CueListDeptAccess } from "@/lib/cue-list-types";

import type { MemberWithRoles } from "@/lib/db";
import CueListDetail from "./CueListDetail";
import ChevronIcon from "./ChevronIcon";
import ProductionTopMenu, {
  PRODUCTION_PAGE_SCROLL_ROOT_CLASS,
  PRODUCTION_TOOLBAR_STAGE,
  ProductionTopMenuDivider,
  PRODUCTION_TOP_MENU_RIGHT_CLASS,
  useProductionToolbar,
} from "./ProductionTopMenu";

type Filter = "all" | "created" | "editable" | "readonly";

const FILTER_LABELS: Record<Filter, string> = {
  all: "全部",
  created: "由我创建",
  editable: "我可编辑",
  readonly: "仅可查看",
};

type DrawerData = {
  cueList: CueList;
  grants: CueListGrant[];
  deptAccess: CueListDeptAccess[];
  productionDepts: { id: string; name: string }[];
  canEdit: boolean;
  canManage: boolean;
};

type Props = {
  productionId: string;
  productionName: string;
  initialCueLists: CueList[];
  canCreate: boolean;
  availableTemplates: { key: string; abbrHint: string | null }[];
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
  availableTemplates: { key: string; abbrHint: string | null }[];
  onCreated: (lists: CueList[]) => void;
  onCancel: () => void;
}) {
  const initTemplate = availableTemplates[0]?.key ?? "";
  const abbrHintOf = (key: string) => availableTemplates.find((t) => t.key === key)?.abbrHint ?? "";
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(initTemplate);
  const [abbr, setAbbrState] = useState(abbrHintOf(initTemplate));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const prevTemplateRef = useRef(initTemplate);
  useEffect(() => {
    const prevHint = abbrHintOf(prevTemplateRef.current);
    const newHint = abbrHintOf(template);
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
                  {t.key}
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
              disabled={saving} placeholder={template ? (abbrHintOf(template) || "如 XQ") : "如 XQ"}
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
  productionName,
  initialCueLists,
  canCreate,
  availableTemplates,
  myUserId,
  editableIds,
  members,
}: Props) {
  const { stage: toolbarStage } = useProductionToolbar();
  const [lists, setLists] = useState(initialCueLists);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  // Drawer state
  const [drawerListId, setDrawerListId] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<DrawerData | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const createButton = canCreate ? (
    <button
      type="button"
      onClick={() => setCreating(true)}
      className="shrink-0"
      style={{
        border: 0,
        borderRadius: 9,
        padding: "7px 16px",
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        background: "var(--ink)",
        color: "#fff",
        whiteSpace: "nowrap",
      }}
    >
      + 新建
    </button>
  ) : null;

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
    <div className={PRODUCTION_PAGE_SCROLL_ROOT_CLASS}>
      {/* Frozen toolbar */}
      <ProductionTopMenu>
        <div className="flex shrink-0 flex-col" style={{ lineHeight: 1.2 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--script)", whiteSpace: "nowrap", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
            {productionName}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>Cue</span>
        </div>
        <ProductionTopMenuDivider />
        <Link
          href={`/production/${productionId}/cues`}
          className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
        >
          <ChevronIcon direction="left" size={12} className="opacity-50" />
          返回
        </Link>
        {toolbarStage < PRODUCTION_TOOLBAR_STAGE.primaryShort && createButton && (
          <div className={`${PRODUCTION_TOP_MENU_RIGHT_CLASS} ml-auto`}>{createButton}</div>
        )}
      </ProductionTopMenu>

      <div className="flex-1 overflow-y-auto" style={{ padding: "24px clamp(18px, 3vw, 52px) 60px" }}>
      <div style={{ background: "white", borderRadius: 12, border: "1px solid var(--line)", padding: "20px 24px", minHeight: "calc(100vh - 280px)" }}>
      <h1 className="mb-4 text-lg font-semibold text-zinc-800">设置</h1>
      {/* Filter tab bar */}
      <div className="mb-5 flex items-start gap-3">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className={styles.tabBar} style={{ marginBottom: 0 }}>
            {(Object.keys(FILTER_LABELS) as Filter[]).map(f => (
              <button key={f} aria-selected={filter === f} onClick={() => setFilter(f)}>
                {FILTER_LABELS[f]}
              </button>
            ))}
          </div>
        </div>
        {toolbarStage >= PRODUCTION_TOOLBAR_STAGE.primaryShort && createButton}
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
                grants={drawerData.grants}
                deptAccess={drawerData.deptAccess}
                productionDepts={drawerData.productionDepts}
                members={members}
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
    </div>
  );
}
