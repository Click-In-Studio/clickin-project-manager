"use client";

import { useState } from "react";
import Link from "next/link";
import type { MentionMember } from "@/components/editor/SmartTextarea";
import ChevronIcon from "@/components/ui/ChevronIcon";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import TreePickerModal from "@/components/ui/TreePickerModal";
import { BASE_PATH } from "@/lib/base-path";
import type { EventReport, EventDepartment } from "@/lib/ops/event-db";
import { fmtDateTime as fmt } from "@/lib/tz";
import ReportEditor from "./ReportEditor";

export default function ReportsTab({
  eventId, productionId, reports, departments, members, canWrite,
  currentUserId, onReportsChange, versionId,
}: {
  eventId: string; productionId: string;
  reports: EventReport[]; departments: EventDepartment[];
  members: MentionMember[];
  canWrite: boolean;
  currentUserId: string;
  onReportsChange: (rs: EventReport[]) => void;
  versionId: string | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("rehearsal");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  // W5：从文档库挂载既有文档为报告
  const [mountPicking, setMountPicking] = useState(false);
  const [mountItems, setMountItems] = useState<{ id: string; label: string; parentId?: string | null }[] | null>(null);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports`;

  async function openMountPicker() {
    setMountPicking(true);
    if (mountItems) return;
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/wiki`);
      const data = await res.json() as { wikis?: { id: string; title: string | null; parentId: string | null; isAnchor: boolean }[] };
      const mounted = new Set(reports.map(r => r.wikiId));
      setMountItems((data.wikis ?? [])
        .filter(w => !w.isAnchor && !mounted.has(w.id))
        .map(w => ({ id: w.id, label: w.title ?? "（无标题）", parentId: w.parentId })));
    } catch {
      setMountItems([]);
    }
  }

  async function mountWiki(ids: string[]) {
    setMountPicking(false);
    const wikiId = ids[0];
    if (!wikiId) return;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wikiId }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error ?? "挂载失败"); return; }
    onReportsChange([...reports, data.report]);
    setMountItems(null);
  }

  async function saveRename(id: string) {
    if (!renameTitle.trim()) return;
    setRenaming(true);
    try {
      const res = await fetch(`${base}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: renameTitle.trim() }),
      });
      const data = await res.json();
      if (data.report) {
        onReportsChange(reports.map(r => r.id === id ? data.report : r));
        setRenameId(null);
      }
    } finally {
      setRenaming(false);
    }
  }

  async function createReport() {
    if (!newTitle.trim()) return;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim(), reportType: newType }),
    });
    const data = await res.json();
    if (data.report) {
      onReportsChange([...reports, data.report]);
      setNewTitle(""); setNewType("rehearsal"); setAdding(false);
    }
  }

  async function deleteReport(id: string) {
    await fetch(`${base}/${id}`, { method: "DELETE" });
    onReportsChange(reports.filter(r => r.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {reports.length === 0 && !adding && (
        <p className="text-sm text-zinc-400 text-center py-6">暂无记录</p>
      )}

      {reports.map(report => (
        <div key={report.id} className="rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 flex items-center gap-3 cursor-pointer"
            onClick={() => { if (renameId !== report.id) setExpandedId(expandedId === report.id ? null : report.id); }}>
            <div className="flex-1 min-w-0">
              {renameId === report.id ? (
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  <input
                    value={renameTitle}
                    onChange={e => setRenameTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveRename(report.id); if (e.key === "Escape") setRenameId(null); }}
                    autoFocus
                    className="flex-1 min-w-0 rounded border border-zinc-200 px-2 py-1 text-sm focus:outline-none focus:border-zinc-400"
                  />
                  <button onClick={() => saveRename(report.id)} disabled={renaming}
                    className="shrink-0 text-[11px] text-blue-500 hover:text-blue-700 disabled:opacity-50">
                    {renaming ? "…" : "保存"}
                  </button>
                  <button onClick={() => setRenameId(null)}
                    className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600">
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-sm font-medium text-zinc-800 truncate block">{report.title}</span>
                  <span className="text-xs text-zinc-400">
                    {fmt(report.createdAt)} · {report.publishedAt ? "已发布" : "草稿"}
                  </span>
                </>
              )}
            </div>
            <span className={`shrink-0 text-[11px] rounded-full px-2 py-0.5 font-medium ${report.publishedAt ? "bg-green-50 text-green-600" : "bg-zinc-100 text-zinc-500"}`}>
              {report.publishedAt ? "已发布" : "草稿"}
            </span>
            {canWrite && renameId !== report.id && (
              <button
                onClick={e => { e.stopPropagation(); setRenameId(report.id); setRenameTitle(report.title); }}
                className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600 px-1"
              >
                改名
              </button>
            )}
            <Link
              href={`/production/${productionId}/reports/${report.id}`}
              onClick={e => e.stopPropagation()}
              className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-600 px-1"
            >
              查看
            </Link>
            <ChevronIcon direction={expandedId === report.id ? "up" : "down"} size={14} className="shrink-0 text-zinc-300" />
          </div>

          {expandedId === report.id && (
            <ReportEditor
              report={report} departments={departments}
              eventId={eventId} productionId={productionId}
              members={members}
              canWrite={canWrite}
              currentUserId={currentUserId}
              versionId={versionId}
              onUpdated={updated => onReportsChange(reports.map(r => r.id === updated.id ? updated : r))}
              onDelete={() => deleteReport(report.id)}
            />
          )}
        </div>
      ))}

      {canWrite && (
        adding ? (
          <div className="rounded-xl bg-white shadow-sm p-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="记录标题 *" value={newTitle} onChange={e => setNewTitle(e.target.value)}
                className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400" />
              <OverflowSafeSelect value={newType} onChange={e => setNewType(e.target.value)}
                className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
                <option value="rehearsal">排练记录</option>
                <option value="performance">演出记录</option>
                <option value="meeting">会议纪要</option>
                <option value="custom">其他</option>
              </OverflowSafeSelect>
            </div>
            <div className="flex gap-2">
              <button onClick={createReport}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium">创建</button>
              <button onClick={() => setAdding(false)} className="text-sm text-zinc-500">取消</button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => setAdding(true)}
              className="flex-1 rounded-xl border-2 border-dashed border-zinc-200 py-3 text-sm text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 transition-colors">
              + 新建记录
            </button>
            <button onClick={openMountPicker}
              title="把文档库中的既有文档挂载为本事件的报告（需要该文档的分享权）"
              className="flex-1 rounded-xl border-2 border-dashed border-zinc-200 py-3 text-sm text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 transition-colors">
              ⧉ 从文档库挂载
            </button>
          </div>
        )
      )}

      {mountPicking && (
        <TreePickerModal
          kicker="Wiki"
          title="挂载文档为报告"
          items={mountItems ?? []}
          preselected={[]}
          single
          onConfirm={mountWiki}
          onClose={() => setMountPicking(false)}
        />
      )}
    </div>
  );
}
