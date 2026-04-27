"use client";

import { useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import { fmtDateTime as fmtDate } from "@/lib/tz";
import Markdown from "./Markdown";
import type { ProductionEvent, EventReport, EventReportNote, EventDepartment, ReportReply } from "@/lib/event-db";

const REPORT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "排练记录", performance: "演出记录", meeting: "会议纪要", custom: "其他",
};


type Props = {
  productionId: string;
  eventId: string;
  event: ProductionEvent;
  report: EventReport;
  notes: EventReportNote[];
  departments: EventDepartment[];
  canWriteNote: boolean;
  canModerateNotes: boolean;
  currentUserOpenId: string;
  isPublished: boolean;
  replies: ReportReply[];
  canReply: boolean;
  memberDeptIds: string[];
};

// ─── NoteCard ─────────────────────────────────────────────────────────────────

function NoteCard({
  note, dept, noteNum, canEdit, onSave, onDelete,
}: {
  note: EventReportNote;
  dept: string | undefined;
  noteNum: number;
  canEdit: boolean;
  onSave: (content: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function save() {
    if (!draft.trim()) return;
    setSaving(true);
    try { await onSave(draft.trim()); setEditing(false); }
    finally { setSaving(false); }
  }

  async function del() {
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  }

  return (
    <div className="rounded-xl bg-zinc-50 px-4 py-3">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          {dept && (
            <span className="text-[11px] font-medium text-zinc-500 bg-zinc-100 rounded px-1.5 py-0.5">{dept}</span>
          )}
          <span className="text-[11px] font-mono text-zinc-300">#{noteNum}</span>
          <span className="text-[11px] text-zinc-400">{note.authorName}</span>
          <span className="text-[10px] text-zinc-300">{fmtDate(note.createdAt)}</span>
        </div>
        {canEdit && (
          <div className="flex gap-2 shrink-0">
            <button onClick={() => { setEditing(!editing); setDraft(note.content); }}
              className="text-[11px] text-zinc-400 hover:text-zinc-600">
              {editing ? "取消" : "编辑"}
            </button>
            <button onClick={del} disabled={deleting}
              className="text-[11px] text-zinc-300 hover:text-red-400 disabled:opacity-50">×</button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
          <button onClick={save} disabled={saving || !draft.trim()}
            className="self-start px-3 py-1 rounded-lg bg-zinc-800 text-white text-xs font-medium disabled:opacity-50">
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      ) : (
        <Markdown content={note.content} size="sm" />
      )}
    </div>
  );
}

// ─── ReplyThread ──────────────────────────────────────────────────────────────
// Flat unlimited-depth thread. All replies (including nested) are shown
// chronologically. Any reply can be replied to; new replies always display
// in the same flat list with an @mention for context.

function collectThread(
  parentType: "report" | "note" | "reply",
  parentId: string,
  allReplies: ReportReply[],
): ReportReply[] {
  const direct = allReplies.filter(r => r.parentType === parentType && r.parentId === parentId);
  const result: ReportReply[] = [];
  for (const r of direct) {
    result.push(r);
    result.push(...collectThread("reply", r.id, allReplies));
  }
  return result;
}

function ReplyThread({
  parentType, parentId, parentLabel,
  allReplies, canAdd, canModerate, currentUserOpenId, replyBase, onRepliesChange,
}: {
  parentType: "report" | "note" | "reply";
  parentId: string;
  parentLabel?: string;
  allReplies: ReportReply[];
  canAdd: boolean;
  canModerate: boolean;
  currentUserOpenId: string;
  replyBase: string;
  onRepliesChange: (updater: (prev: ReportReply[]) => ReportReply[]) => void;
}) {
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [addingTop, setAddingTop] = useState(false);

  const thread = collectThread(parentType, parentId, allReplies);

  // Build a lookup of id → authorName for @mentions
  const authorMap = new Map<string, string>();
  for (const r of allReplies) authorMap.set(r.id, r.authorName);

  async function sendReply(replyParentType: "report" | "note" | "reply", replyParentId: string, content: string) {
    const res = await fetch(replyBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentType: replyParentType, parentId: replyParentId, content }),
    });
    const data = await res.json();
    if (data.reply) {
      onRepliesChange(prev => [...prev, data.reply]);
      setReplyingToId(null);
      setAddingTop(false);
    }
  }

  async function deleteReply(id: string) {
    const res = await fetch(`${replyBase}/${id}`, { method: "DELETE" });
    if (res.ok) onRepliesChange(prev => prev.filter(r => r.id !== id));
  }

  if (thread.length === 0 && !canAdd) return null;

  return (
    <div className="mt-2 border-l-2 border-zinc-100 pl-3 flex flex-col gap-1.5">
      {thread.map(reply => {
        const replyingTo = reply.parentType === "reply" ? authorMap.get(reply.parentId) : undefined;
        const canDelete = canModerate || reply.openId === currentUserOpenId;
        const isReplying = replyingToId === reply.id;

        return (
          <div key={reply.id}>
            <div className="rounded-xl bg-zinc-50 px-4 py-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium text-zinc-700">{reply.authorName}</span>
                  {replyingTo && (
                    <span className="text-[10px] text-zinc-400">→ {replyingTo}</span>
                  )}
                  <span className="text-[10px] text-zinc-300">{fmtDate(reply.createdAt)}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canAdd && (
                    <button
                      onClick={() => setReplyingToId(isReplying ? null : reply.id)}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600">
                      {isReplying ? "取消" : "回复"}
                    </button>
                  )}
                  {canDelete && (
                    <button onClick={() => deleteReply(reply.id)}
                      className="text-[11px] text-zinc-300 hover:text-red-400">×</button>
                  )}
                </div>
              </div>
              <Markdown content={reply.content} size="sm" />
            </div>

            {isReplying && (
              <ReplyForm
                placeholder={`回复 ${reply.authorName}…`}
                onSend={content => sendReply("reply", reply.id, content)}
                onCancel={() => setReplyingToId(null)}
              />
            )}
          </div>
        );
      })}

      {canAdd && (
        addingTop ? (
          <ReplyForm
            placeholder={parentLabel ? `回复 ${parentLabel}…` : "写回复…"}
            onSend={content => sendReply(parentType, parentId, content)}
            onCancel={() => setAddingTop(false)}
          />
        ) : (
          <button onClick={() => setAddingTop(true)}
            className="self-start text-[11px] text-zinc-400 hover:text-zinc-600 pt-0.5">
            + 添加回复
          </button>
        )
      )}
    </div>
  );
}

function ReplyForm({
  placeholder, onSend, onCancel,
}: {
  placeholder: string;
  onSend: (content: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!content.trim()) return;
    setSubmitting(true);
    try { await onSend(content.trim()); setContent(""); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      <textarea value={content} onChange={e => setContent(e.target.value)} rows={2}
        placeholder={placeholder} autoFocus
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
      <div className="flex gap-2">
        <button onClick={submit} disabled={submitting || !content.trim()}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium disabled:opacity-50">
          {submitting ? "发送中…" : "发送"}
        </button>
        <button onClick={onCancel} className="text-sm text-zinc-400 hover:text-zinc-600">取消</button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReportViewClient({
  productionId, eventId, event, report,
  notes: initialNotes, departments,
  canWriteNote, canModerateNotes,
  currentUserOpenId, isPublished,
  replies: initialReplies, canReply, memberDeptIds,
}: Props) {
  const [notes, setNotes] = useState(initialNotes);
  const [replies, setReplies] = useState(initialReplies);
  const [newDeptId, setNewDeptId] = useState(departments[0]?.id ?? "");
  const [newContent, setNewContent] = useState("");
  const [adding, setAdding] = useState(false);

  const deptMap = new Map(departments.map(d => [d.id, d.name]));
  const noteBase = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports/${report.id}/notes`;
  const replyBase = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports/${report.id}/replies`;

  async function addNote() {
    if (!newContent.trim() || !newDeptId) return;
    setAdding(true);
    try {
      const res = await fetch(noteBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: newDeptId, content: newContent.trim() }),
      });
      const data = await res.json();
      if (data.note) { setNotes(prev => [...prev, data.note]); setNewContent(""); }
    } finally { setAdding(false); }
  }

  async function saveNote(noteId: string, content: string) {
    const res = await fetch(`${noteBase}/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (data.note) setNotes(prev => prev.map(n => n.id === noteId ? data.note : n));
  }

  async function deleteNote(noteId: string) {
    const res = await fetch(`${noteBase}/${noteId}`, { method: "DELETE" });
    if (res.ok) setNotes(prev => prev.filter(n => n.id !== noteId));
  }

  const grouped = new Map<string, EventReportNote[]>();
  const noDept: EventReportNote[] = [];
  for (const n of notes) {
    if (deptMap.has(n.departmentId)) {
      if (!grouped.has(n.departmentId)) grouped.set(n.departmentId, []);
      grouped.get(n.departmentId)!.push(n);
    } else {
      noDept.push(n);
    }
  }

  // Can reply to a specific note: canReply AND in that department (production-wide)
  function canReplyToNote(note: EventReportNote) {
    return canReply && memberDeptIds.includes(note.departmentId);
  }

  const commonThreadProps = { canModerate: canModerateNotes, currentUserOpenId, replyBase, onRepliesChange: setReplies };

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-xl mx-auto px-4 pt-8 pb-16">
        {/* Nav */}
        <div className="flex items-center gap-3 mb-5 text-xs text-zinc-400">
          <Link href={`/production/${productionId}/events/${eventId}/view`} className="hover:text-zinc-600">
            ← {event.title}
          </Link>
        </div>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl font-bold text-zinc-800 leading-tight">{report.title}</h1>
            <span className={`shrink-0 text-[11px] rounded-full px-2.5 py-1 font-medium ${
              report.publishedAt ? "bg-green-50 text-green-600" : "bg-zinc-100 text-zinc-500"
            }`}>
              {report.publishedAt ? "已发布" : "草稿"}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-400">
            <span>{REPORT_TYPE_LABELS[report.reportType] ?? report.reportType}</span>
            {report.publishedAt && <span>{fmtDate(report.publishedAt)}</span>}
          </div>
        </div>

        {/* Report body + replies */}
        <section className="mb-6">
          {report.body ? (
            <div className="bg-white rounded-2xl shadow-sm px-5 py-4">
              <Markdown content={report.body} />
            </div>
          ) : (
            <p className="text-center text-sm text-zinc-300">暂无正文</p>
          )}
          <ReplyThread
            parentType="report" parentId={report.id}
            allReplies={replies} canAdd={canReply}
            {...commonThreadProps}
          />
        </section>

        {/* Notes section */}
        <section>
          <h2 className="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase mb-3">部门 Notes</h2>

          {notes.length === 0 && (
            <p className="text-xs text-zinc-300 py-4 text-center">暂无 Notes</p>
          )}

          {[...grouped.entries()].map(([deptId, deptNotes]) => (
            <div key={deptId} className="mb-4">
              <p className="text-[11px] font-semibold text-zinc-300 mb-2">{deptMap.get(deptId)}</p>
              <div className="flex flex-col gap-3">
                {deptNotes.map((note, i) => (
                  <div key={note.id}>
                    <NoteCard
                      note={note} dept={undefined} noteNum={i + 1}
                      canEdit={!isPublished && (canModerateNotes || note.authorOpenId === currentUserOpenId)}
                      onSave={content => saveNote(note.id, content)}
                      onDelete={() => deleteNote(note.id)}
                    />
                    <ReplyThread
                      parentType="note" parentId={note.id} parentLabel={note.authorName}
                      allReplies={replies} canAdd={canReplyToNote(note)}
                      {...commonThreadProps}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {noDept.map((note, i) => (
            <div key={note.id} className="mb-3">
              <NoteCard
                note={note} dept={deptMap.get(note.departmentId)} noteNum={i + 1}
                canEdit={!isPublished && (canModerateNotes || note.authorOpenId === currentUserOpenId)}
                onSave={content => saveNote(note.id, content)}
                onDelete={() => deleteNote(note.id)}
              />
              <ReplyThread
                parentType="note" parentId={note.id} parentLabel={note.authorName}
                allReplies={replies} canAdd={canReplyToNote(note)}
                {...commonThreadProps}
              />
            </div>
          ))}

          {canWriteNote && !isPublished && departments.length > 0 && (
            <div className="mt-4 bg-white rounded-2xl shadow-sm px-5 py-4 flex flex-col gap-3">
              <p className="text-xs font-medium text-zinc-400">添加 Note</p>
              <select value={newDeptId} onChange={e => setNewDeptId(e.target.value)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400">
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <textarea value={newContent} onChange={e => setNewContent(e.target.value)} rows={3}
                placeholder="写 note…"
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:border-zinc-400 resize-none" />
              <button onClick={addNote} disabled={adding || !newContent.trim()}
                className="self-start px-4 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50">
                {adding ? "添加中…" : "添加"}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
