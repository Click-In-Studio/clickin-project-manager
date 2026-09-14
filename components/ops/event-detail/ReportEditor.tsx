"use client";

import { useState } from "react";
import Link from "next/link";
import MountPointAssets from "@/components/assets/MountPointAssets";
import type { MentionMember } from "@/components/editor/SmartTextarea";
import MarkdownEditor from "@/components/ui/MarkdownEditor";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import { BASE_PATH } from "@/lib/base-path";
import type { EventReport, EventDepartment } from "@/lib/ops/event-db";
import DeptNotesList from "./DeptNotesList";

export default function ReportEditor({
  report, departments, eventId, productionId, members, canWrite,
  currentUserId, versionId,
  onUpdated, onDelete,
}: {
  report: EventReport; departments: EventDepartment[];
  eventId: string; productionId: string;
  members: MentionMember[];
  canWrite: boolean;
  currentUserId: string;
  versionId: string | null;
  onUpdated: (r: EventReport) => void; onDelete: () => void;
}) {
  const [body, setBody] = useState(report.body);
  const [mentions, setMentions] = useState(report.mentions);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports`;
  const isPublished = !!report.publishedAt;

  async function saveBody() {
    setSaving(true);
    const res = await fetch(`${base}/${report.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, mentions }),
    });
    const data = await res.json();
    setSaving(false);
    if (data.report) onUpdated(data.report);
  }

  return (
    <div className="px-4 pb-4 border-t border-zinc-100 flex flex-col gap-4 pt-3">
      {/* Body: editable only when canWrite and not yet published */}
      {canWrite && !isPublished ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-zinc-400">正文</label>
            {/* W5 统一日：报告=挂载的 wiki 文档，可去文档视图编辑（全屏/树上下文） */}
            {report.wikiId && (
              <Link href={`/production/${productionId}/wiki/${report.wikiId}`}
                className="text-xs text-sky-700 hover:underline">
                在文档视图中编辑 ↗
              </Link>
            )}
          </div>
          <MarkdownEditor
            content={body}
            onChange={setBody}
            onMentionsChange={setMentions}
            members={members}
            productionId={productionId}
            placeholder="写报告正文… 输入 / 插入块，@ 可提及成员，# 可引用剧本位置"
            minHeight={200}
          />
          <div className="flex gap-2 flex-wrap items-center">
            <button onClick={saveBody} disabled={saving || body === report.body}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium disabled:opacity-50">
              {saving ? "…" : "保存"}
            </button>
            {confirmDelete ? (
              <span className="flex items-center gap-2 ml-auto">
                <span className="text-xs text-red-500">确认？</span>
                <button onClick={onDelete} className="px-2 py-1 text-xs bg-red-500 text-white rounded-lg">删除</button>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-400">取消</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="ml-auto text-xs text-red-400 hover:text-red-600">
                删除记录
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {report.body
            ? <WikiMarkdown content={report.body} productionId={productionId} />
            : <p className="text-xs text-zinc-300">暂无正文</p>
          }
          {canWrite && !isPublished && (
            <div className="flex gap-2 mt-1">
              {confirmDelete ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-red-500">确认？</span>
                  <button onClick={onDelete} className="px-2 py-1 text-xs bg-red-500 text-white rounded-lg">删除</button>
                  <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-400">取消</button>
                </span>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="text-xs text-red-400 hover:text-red-600">
                  删除记录
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <MountPointAssets
        productionId={productionId}
        mountType="event_report"
        mountId={report.id}
        label={report.title}
        canEdit={canWrite && !isPublished}
        display="panel"
      />

      <DeptNotesList
        reportId={report.id} eventId={eventId} productionId={productionId}
        departments={departments.filter(d => d.kind === "dept")}
        members={members}
        currentUserId={currentUserId}
        isPublished={isPublished}
        versionId={versionId}
      />
    </div>
  );
}
