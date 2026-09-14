"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type { ProductionEvent } from "@/lib/ops/event-db";

export default function EventChatSection({
  event, productionId, canEdit, onChatIdSet, onChatIdCleared,
}: {
  event: ProductionEvent;
  productionId: string;
  canEdit: boolean;
  onChatIdSet: (chatId: string) => void;
  onChatIdCleared: () => void;
}) {
  const [bindQuery, setBindQuery] = useState("");
  const [bindResults, setBindResults] = useState<{ chatId: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showBind, setShowBind] = useState(false);

  async function createChat() {
    if (!confirm("确定为此事件创建飞书群吗？")) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const data = await res.json();
      if (data.chatId) onChatIdSet(data.chatId);
      else alert(data.error ?? "建群失败");
    } finally { setBusy(false); }
  }

  async function searchBindable() {
    if (!bindQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/chats/bindable?q=${encodeURIComponent(bindQuery)}`);
      const data = await res.json();
      setBindResults(data.chats ?? []);
    } finally { setSearching(false); }
  }

  async function bindChat(chatId: string) {
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bind", chatId }),
      });
      const data = await res.json();
      if (data.chatId) { onChatIdSet(data.chatId); setShowBind(false); }
      else alert(data.error ?? "绑定失败");
    } finally { setBusy(false); }
  }

  async function unbindChat() {
    if (!confirm("确定解绑飞书群吗？群本身不会被删除。")) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/events/${event.id}/chat`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) onChatIdCleared();
      else alert(data.error ?? "解绑失败");
    } finally { setBusy(false); }
  }

  if (event.chatId) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">飞书群</span>
        <span className="text-xs bg-blue-50 text-blue-600 rounded-lg px-2 py-1 font-medium">已绑定</span>
        {canEdit && (
          <button onClick={unbindChat} disabled={busy}
            className="text-xs text-zinc-400 hover:text-red-500 disabled:opacity-50 underline">
            {busy ? "…" : "解绑"}
          </button>
        )}
      </div>
    );
  }

  if (!canEdit) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 flex-wrap">
        <button onClick={createChat} disabled={busy}
          className="px-3 py-1.5 rounded-lg border border-blue-200 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50">
          {busy ? "…" : "创建飞书群"}
        </button>
        <button onClick={() => setShowBind(b => !b)} disabled={busy}
          className="px-3 py-1.5 rounded-lg border border-zinc-200 text-sm text-zinc-600 hover:bg-zinc-50">
          绑定现有群
        </button>
      </div>
      {showBind && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input value={bindQuery} onChange={e => setBindQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && searchBindable()}
              placeholder="搜索群名…"
              className="flex-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-400" />
            <button onClick={searchBindable} disabled={searching}
              className="px-3 py-1.5 rounded-lg bg-zinc-100 text-sm text-zinc-600 hover:bg-zinc-200 disabled:opacity-50">
              {searching ? "…" : "搜索"}
            </button>
          </div>
          {bindResults !== null && (
            bindResults.length === 0
              ? <p className="text-xs text-zinc-400">未找到可绑定的群</p>
              : <div className="flex flex-col gap-1">
                  {bindResults.map(c => (
                    <button key={c.chatId} onClick={() => bindChat(c.chatId)} disabled={busy}
                      className="text-left rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 border border-zinc-100 disabled:opacity-50">
                      {c.name}
                    </button>
                  ))}
                </div>
          )}
        </div>
      )}
    </div>
  );
}
