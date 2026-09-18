"use client";

// 手册搜索框（#538）：首页大框与顶栏小框共用。第一次聚焦时拉一次索引，之后本地过滤；
// 结果列表键盘可选（↑↓ Enter Esc）。

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import { searchDocs, type SearchDoc } from "@/lib/help/search-score";

let indexPromise: Promise<SearchDoc[]> | null = null;
function loadIndex(): Promise<SearchDoc[]> {
  indexPromise ??= fetch(`${BASE_PATH}/api/help/search-index`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return indexPromise;
}

export default function HelpSearch({ size = "small", autoFocus = false }: { size?: "small" | "large"; autoFocus?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [docs, setDocs] = useState<SearchDoc[] | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const results = docs && q.trim() ? searchDocs(docs, q) : [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => { setActive(0); }, [q]);

  const go = (slug: string) => { setOpen(false); setQ(""); router.push(`/help/${slug}`); };

  return (
    <div ref={box} className={`help-search-wrap${size === "large" ? " is-large" : ""}`}>
      <label className="help-search">
        <span aria-hidden>⌕</span>
        <input
          type="search"
          value={q}
          placeholder="搜索手册"
          aria-label="搜索手册"
          autoFocus={autoFocus}
          onFocus={() => { setOpen(true); if (!docs) loadIndex().then(setDocs); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && results[active]) { e.preventDefault(); go(results[active].doc.slug); }
            else if (e.key === "Escape") { setOpen(false); (e.target as HTMLInputElement).blur(); }
          }}
        />
      </label>
      {open && q.trim() && (
        <div className="help-search-results" role="listbox">
          {docs === null ? (
            <div className="help-search-empty">加载中…</div>
          ) : results.length === 0 ? (
            <div className="help-search-empty">没有找到「{q.trim()}」。换个说法试试，或者从左侧目录翻。</div>
          ) : results.map((r, i) => (
            <button
              key={r.doc.slug}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`help-search-item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r.doc.slug)}
            >
              <span className="help-search-crumbs">{r.doc.crumbs}</span>
              <span className="help-search-title">{r.doc.title}</span>
              <span className="help-search-snippet">{r.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
