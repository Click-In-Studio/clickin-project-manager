"use client";

import { useState } from "react";
import type { NotifPref } from "@/lib/notification-prefs";
import { BASE_PATH } from "@/lib/base-path";

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
        enabled ? "bg-blue-500" : "bg-zinc-300"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
          enabled ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function PrefRow({
  pref,
  onToggle,
}: {
  pref: NotifPref & { pending?: boolean };
  onToggle: (type: string, enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-4 border-b border-zinc-100 last:border-0">
      <div className="flex-1 min-w-0 pr-4">
        <p className="text-sm font-medium text-zinc-800">{pref.label}</p>
        <p className="text-xs text-zinc-400 mt-0.5">{pref.description}</p>
      </div>
      <Toggle enabled={pref.enabled} onChange={(v) => onToggle(pref.type, v)} />
    </div>
  );
}

export default function NotificationsClient({ prefs: initialPrefs }: { prefs: NotifPref[] }) {
  const [prefs, setPrefs] = useState(initialPrefs);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(type: string, enabled: boolean) {
    setSaving(type);
    setError(null);
    setPrefs((prev) => prev.map((p) => (p.type === type ? { ...p, enabled } : p)));
    try {
      const res = await fetch(`${BASE_PATH}/api/my/notification-prefs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, enabled }),
      });
      if (!res.ok) throw new Error("保存失败");
    } catch {
      setPrefs((prev) => prev.map((p) => (p.type === type ? { ...p, enabled: !enabled } : p)));
      setError("保存失败，请重试");
    } finally {
      setSaving(null);
    }
  }

  const dmPrefs = prefs.filter((p) => p.channel === "dm");
  const groupPrefs = prefs.filter((p) => p.channel === "group");

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="max-w-lg mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold text-zinc-800 mb-6">通知设置</h1>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}

        <section className="mb-6">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">
            可以关闭的通知
          </h2>
          <p className="text-xs text-zinc-400 mb-3 px-1">以下通知默认开启，你可以选择关闭。</p>
          <div className="bg-white rounded-2xl shadow-sm px-5">
            {dmPrefs.map((p) => (
              <PrefRow
                key={p.type}
                pref={{ ...p, pending: saving === p.type }}
                onToggle={handleToggle}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">
            可以额外订阅的群通知
          </h2>
          <p className="text-xs text-zinc-400 mb-3 px-1">
            以下通知默认发送至群，开启后机器人也会额外私信你一份。
          </p>
          <div className="bg-white rounded-2xl shadow-sm px-5">
            {groupPrefs.map((p) => (
              <PrefRow
                key={p.type}
                pref={{ ...p, pending: saving === p.type }}
                onToggle={handleToggle}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
