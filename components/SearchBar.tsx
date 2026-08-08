"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import type { ProductionSearchResults } from "@/lib/search-db";

// ─── Event type labels ────────────────────────────────────────────────────────
const EVENT_TYPE_LABEL: Record<string, string> = {
  rehearsal: "排练",
  performance: "演出",
  read_through: "围读",
  production_meeting: "制作会",
  design_meeting: "设计会",
  other: "其他",
};

// ─── Date formatting ──────────────────────────────────────────────────────────
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ResultSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 pt-3 pb-1 text-[9px] font-bold tracking-[0.12em] uppercase text-[#667676]">
        {label}
      </div>
      {children}
    </div>
  );
}

function ResultRow({
  onClick,
  primary,
  secondary,
  tag,
}: {
  onClick: () => void;
  primary: string;
  secondary?: string;
  tag?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--paper)] transition-colors text-left rounded-[7px]"
    >
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-[#182a2a] truncate">{primary}</div>
        {secondary && (
          <div className="text-[10px] text-[#667676] truncate mt-0.5">{secondary}</div>
        )}
      </div>
      {tag && (
        <span className="shrink-0 text-[9px] text-[#667676] border border-[var(--line)] rounded px-1.5 py-0.5">
          {tag}
        </span>
      )}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface SearchBarProps {
  productionId: string | null;
  onOpenChange?: (open: boolean) => void;
}

export default function SearchBar({ productionId, onOpenChange }: SearchBarProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductionSearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transitionFrameRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (transitionFrameRef.current !== null) {
      cancelAnimationFrame(transitionFrameRef.current);
    }
  }, []);

  const handleClose = useCallback(() => {
    if (transitionFrameRef.current !== null) {
      cancelAnimationFrame(transitionFrameRef.current);
    }
    setIsOpen(false);
    setQuery("");
    setResults(null);
    if (!onOpenChange) return;
    transitionFrameRef.current = requestAnimationFrame(() => {
      transitionFrameRef.current = null;
      onOpenChange(false);
    });
  }, [onOpenChange]);

  const handleOpen = () => {
    if (transitionFrameRef.current !== null) {
      cancelAnimationFrame(transitionFrameRef.current);
    }
    if (!onOpenChange) {
      setIsOpen(true);
      transitionFrameRef.current = requestAnimationFrame(() => {
        transitionFrameRef.current = null;
        inputRef.current?.focus();
      });
      return;
    }
    // Commit the menu hide before the next frame can expand the input.
    flushSync(() => onOpenChange(true));
    transitionFrameRef.current = requestAnimationFrame(() => {
      setIsOpen(true);
      transitionFrameRef.current = requestAnimationFrame(() => {
        transitionFrameRef.current = null;
        inputRef.current?.focus();
      });
    });
  };

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, handleClose]);

  // Debounced search
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !productionId) {
      setResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/production/${productionId}/search?q=${encodeURIComponent(trimmed)}`,
          { credentials: "same-origin" },
        );
        if (res.ok) setResults(await res.json());
      } catch {
        // silently ignore network errors
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, productionId]);

  const navigate = (href: string) => {
    router.push(href);
    handleClose();
  };

  const hasAnyResults = results && (
    results.events.length > 0 ||
    results.techReqs.length > 0 ||
    results.contacts.length > 0 ||
    results.scenes.length > 0 ||
    results.characters.length > 0 ||
    results.assets.length > 0
  );

  const showDropdown = isOpen && query.trim().length >= 1;

  if (!productionId) return null;

  return (
    <div ref={containerRef} className="relative">
      {/* ── Trigger button (idle) ── */}
      {!isOpen && (
        <button
          type="button"
          onClick={handleOpen}
          aria-label="搜索"
          className="flex items-center gap-1.5 h-9 px-3 border border-[var(--line)] bg-[var(--paper)] rounded-lg text-[#667676] hover:border-[#182a2a] hover:text-[#182a2a] transition-colors text-[11px] shrink-0"
        >
          <span className="text-[14px] leading-none">⌕</span>
          <span className="hidden md:block">搜索</span>
        </button>
      )}

      {/* ── Active input ── */}
      {isOpen && (
        <div className="relative flex items-center">
          <span className="absolute left-2.5 text-[14px] text-[#667676] pointer-events-none leading-none">⌕</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && handleClose()}
            placeholder="搜索日程、人员、技术需求…"
            className="h-9 w-[220px] md:w-[260px] pl-8 pr-3 border border-[#2f6670] rounded-lg bg-[var(--surface)] text-[11px] text-[#182a2a] outline-none shadow-[0_0_0_3px_rgba(47,102,112,0.12)] placeholder:text-[#667676]"
          />
          {loading && (
            <span className="absolute right-2.5 text-[10px] text-[#667676] animate-pulse">…</span>
          )}
        </div>
      )}

      {/* ── Results dropdown ── */}
      {showDropdown && (
        <div className="absolute left-0 top-full mt-2 w-[320px] bg-[var(--surface)] border border-[var(--line)] rounded-[13px] shadow-[0_18px_55px_rgba(24,42,42,.18)] z-50 overflow-hidden max-h-[70vh] overflow-y-auto">
          {!loading && !hasAnyResults && query.trim().length >= 1 && (
            <div className="px-4 py-4 text-center text-[12px] text-[#667676]">
              没有找到「{query}」相关内容
            </div>
          )}

          {!loading && (
            <div className="py-1.5">
              {hasAnyResults && (
                <>
                  {/* 日程 */}
                  {results!.events.length > 0 && (
                    <ResultSection label={results!.dateQuery ? `${results!.dateQuery} 的日程` : "日程"}>
                      {results!.events.map((e) => (
                        <ResultRow
                          key={e.id}
                          onClick={() => navigate(`/production/${productionId}/events/${e.id}`)}
                          primary={e.title}
                          secondary={[fmtDate(e.startTime), e.location].filter(Boolean).join(" · ")}
                          tag={EVENT_TYPE_LABEL[e.eventType] ?? e.eventType}
                        />
                      ))}
                    </ResultSection>
                  )}

                  {/* 技术需求 */}
                  {results!.techReqs.length > 0 && (
                    <>
                      {results!.events.length > 0 && <div className="mx-3 my-1 border-t border-[var(--line)]" />}
                      <ResultSection label="技术需求">
                        {results!.techReqs.map((r) => (
                          <ResultRow
                            key={r.id}
                            onClick={() => navigate(`/production/${productionId}/tasks/${r.id}`)}
                            primary={r.title}
                            secondary={[r.deptName, r.eventTitle].filter(Boolean).join(" · ")}
                          />
                        ))}
                      </ResultSection>
                    </>
                  )}

                  {/* 人员 */}
                  {results!.contacts.length > 0 && (
                    <>
                      {(results!.events.length > 0 || results!.techReqs.length > 0) && (
                        <div className="mx-3 my-1 border-t border-[var(--line)]" />
                      )}
                      <ResultSection label="人员">
                        {results!.contacts.map((c) => (
                          <ResultRow
                            key={c.userId}
                            onClick={() => navigate(`/production/${productionId}/contacts`)}
                            primary={c.name}
                            secondary={c.matchHint ?? (c.roles.slice(0, 2).join(" · ") || undefined)}
                          />
                        ))}
                      </ResultSection>
                    </>
                  )}

                  {/* 章节/段落 */}
                  {results!.scenes.length > 0 && (
                    <>
                      {(results!.events.length > 0 || results!.techReqs.length > 0 || results!.contacts.length > 0) && (
                        <div className="mx-3 my-1 border-t border-[var(--line)]" />
                      )}
                      <ResultSection label="章节/段落">
                        {results!.scenes.map((s) => (
                          <ResultRow
                            key={s.id}
                            onClick={() => navigate(`/production/${productionId}/scenes/${s.id}`)}
                            primary={s.name}
                            secondary={s.matchHint ?? undefined}
                          />
                        ))}
                      </ResultSection>
                    </>
                  )}

                  {/* 角色 */}
                  {results!.characters.length > 0 && (
                    <>
                      {(results!.events.length > 0 || results!.techReqs.length > 0 || results!.contacts.length > 0 || results!.scenes.length > 0) && (
                        <div className="mx-3 my-1 border-t border-[var(--line)]" />
                      )}
                      <ResultSection label="角色">
                        {results!.characters.map((c) => (
                          <ResultRow
                            key={c.id}
                            onClick={() => navigate(`/production/${productionId}/characters/${c.id}`)}
                            primary={c.name}
                            secondary={c.matchHint ?? undefined}
                          />
                        ))}
                      </ResultSection>
                    </>
                  )}

                  {/* 数字资产 */}
                  {results!.assets.length > 0 && (
                    <>
                      {(results!.events.length > 0 || results!.techReqs.length > 0 || results!.contacts.length > 0 || results!.scenes.length > 0 || results!.characters.length > 0) && (
                        <div className="mx-3 my-1 border-t border-[var(--line)]" />
                      )}
                      <ResultSection label="数字资产">
                        {results!.assets.map((a) => (
                          <ResultRow
                            key={a.id}
                            onClick={() => navigate(`/production/${productionId}/assets/${a.id}/preview`)}
                            primary={a.name ?? a.fileName}
                            secondary={a.name ? a.fileName : undefined}
                            tag={a.assetType}
                          />
                        ))}
                      </ResultSection>
                    </>
                  )}
                </>
              )}

              {/* 剧本文本搜索入口 */}
              {hasAnyResults && <div className="mx-3 mt-1.5 mb-1 border-t border-[var(--line)]" />}
              <button
                type="button"
                onClick={() => navigate(`/production/${productionId}/script?q=${encodeURIComponent(query.trim())}`)}
                className="w-full flex items-center justify-between px-3 py-2 text-[10px] text-[#667676] hover:bg-[var(--paper)] hover:text-[#182a2a] transition-colors rounded-[7px]"
              >
                <span>在剧本文本中搜索「{query.trim()}」</span>
                <span className="text-[8px] border border-[var(--line)] rounded px-1.5 py-0.5">剧本</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
