"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";

export default function ArchiveButton({
  productionId,
  isArchived,
}: {
  productionId: string;
  isArchived: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const label = isArchived ? "取消归档" : "归档";
    if (!confirm(isArchived ? "确定要取消归档该项目吗？" : "确定要归档该项目吗？归档后所有人失去写权限。"))
      return;
    setLoading(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/archive`, {
        method: isArchived ? "DELETE" : "POST",
      });
      if (!res.ok) {
        const d = await res.json();
        alert(d.error ?? `${label}失败`);
        return;
      }
      router.refresh();
    } catch {
      alert("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={loading}
      className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-40 transition-colors"
    >
      {loading ? "处理中…" : isArchived ? "取消归档" : "归档项目"}
    </button>
  );
}
