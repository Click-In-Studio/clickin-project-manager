"use client";

import { useState } from "react";
import SmartTextarea, { type MentionMember } from "@/components/editor/SmartTextarea";
import ChevronIcon from "@/components/ui/ChevronIcon";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import SmartText from "@/components/ui/SmartText";
import { BASE_PATH } from "@/lib/base-path";
import type { EventReportNote, EventDepartment } from "@/lib/ops/event-db";

export default function DeptNotesList({
  reportId, eventId, productionId, departments, members,
  currentUserId, isPublished, versionId,
}: {
  reportId: string; eventId: string; productionId: string;
  departments: EventDepartment[];
  members: MentionMember[];
  currentUserId: string;
  isPublished: boolean;
  versionId: string | null;
}) {
  const [notes, setNotes] = useState<EventReportNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editMentions, setEditMentions] = useState<MentionMember[]>([]);
  const [newDeptId, setNewDeptId] = useState(departments[0]?.id ?? "");
  const [newContent, setNewContent] = useState("");
  const [newMentions, setNewMentions] = useState<MentionMember[]>([]);

  const base = `${BASE_PATH}/api/production/${productionId}/events/${eventId}/reports/${reportId}/notes`;

  async function load() {
    const res = await fetch(base);
    const data = await res.json();
    if (data.notes) { setNotes(data.notes); setLoaded(true); }
  }

  async function addNote() {
    if (!newContent.trim() || !newDeptId) return;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ departmentId: newDeptId, content: newContent.trim(), mentions: newMentions }),
    });
    const data = await res.json();
    if (data.note) { setNotes(prev => [...prev, data.note]); setNewContent(""); setNewMentions([]); }
  }

  async function saveEdit(id: string) {
    if (!editDraft.trim()) return;
    const res = await fetch(`${base}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editDraft.trim(), mentions: editMentions }),
    });
    const data = await res.json();
    if (data.note) { setNotes(prev => prev.map(n => n.id === id ? data.note : n)); setEditingId(null); }
  }

  async function deleteNote(id: string) {
    await fetch(`${base}/${id}`, { method: "DELETE" });
    setNotes(prev => prev.filter(n => n.id !== id));
  }

  if (!loaded) {
    return (
      <button onClick={load} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600">
        <ChevronIcon size={12} />
        查看部门 Notes
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">部门 Notes</p>
      {notes.length === 0 && <p className="text-xs text-zinc-300 text-center py-2">暂无 Notes</p>}
      {notes.map(note => {
        const dept = departments.find(d => d.id === note.departmentId);
        const isOwn = note.authorUserId === currentUserId;
        return (
          <div key={note.id} className="rounded-lg bg-zinc-50 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                {dept && <span className="text-[11px] font-medium text-zinc-500">{dept.name}</span>}
                <span className="text-[11px] text-zinc-400">{note.authorName}</span>
              </div>
              {!isPublished && (
                <div className="flex gap-2 shrink-0">
                  {isOwn && (
                    <button onClick={() => {
                      setEditingId(editingId === note.id ? null : note.id);
                      setEditDraft(note.content);
                      setEditMentions(note.mentions ?? []);
                    }} className="text-[11px] text-zinc-400 hover:text-zinc-600">
                      {editingId === note.id ? "取消" : "编辑"}
                    </button>
                  )}
                  <button onClick={() => deleteNote(note.id)} className="text-xs text-zinc-300 hover:text-red-400">×</button>
                </div>
              )}
            </div>
            {editingId === note.id ? (
              <div className="flex flex-col gap-1.5">
                <SmartTextarea
                  value={editDraft}
                  onChange={setEditDraft}
                  memberMention={{ members, onMentionsChange: setEditMentions }}
                  contentMention={{ productionId, versionId }}
                  rows={2}
                  placeholder="写 note…"
                  className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm focus:outline-none resize-none"
                />
                <button onClick={() => saveEdit(note.id)}
                  className="self-start px-2 py-1 text-xs rounded-lg bg-zinc-800 text-white">保存</button>
              </div>
            ) : (
              <SmartText content={note.content} memberMention={{ members: note.mentions ?? [] }} contentMention={{ productionId }} />
            )}
          </div>
        );
      })}
      {!isPublished && departments.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-1">
          <div className="flex gap-2">
            <OverflowSafeSelect value={newDeptId} onChange={e => setNewDeptId(e.target.value)}
              className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs focus:outline-none shrink-0">
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </OverflowSafeSelect>
            <button onClick={addNote}
              className="ml-auto px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-xs font-medium shrink-0">添加</button>
          </div>
          <SmartTextarea
            value={newContent}
            onChange={setNewContent}
            memberMention={{ members, onMentionsChange: setNewMentions }}
            contentMention={{ productionId, versionId }}
            rows={2}
            placeholder="写 note… 输入 @ 可提及成员"
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNote(); } }}
            className="w-full rounded-lg border border-zinc-200 px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-400 resize-none"
          />
        </div>
      )}
    </div>
  );
}
