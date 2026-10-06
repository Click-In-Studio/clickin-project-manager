"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import NavigationIcon from "@/components/shell/app-shell/NavigationIcon";
import type { WikiOutlineItem } from "@/lib/wiki/outline-types";
import { activeWikiOutlineId } from "@/lib/wiki/outline-types";

function scrollSourceTo(item: WikiOutlineItem, root: HTMLElement): boolean {
  const source = root.querySelector<HTMLTextAreaElement>("[data-wiki-source-editor]");
  if (!source) return false;
  source.focus();
  source.setSelectionRange(item.offset, item.endOffset);
  const progress = item.offset / Math.max(1, source.value.length);
  source.scrollTop = progress * Math.max(0, source.scrollHeight - source.clientHeight);
  source.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

export default function WikiOutline({
  items,
  contentRef,
}: {
  items: WikiOutlineItem[];
  contentRef: RefObject<HTMLElement | null>;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);
  const headingRefs = useRef<HTMLElement[]>([]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3"));
    headings.forEach((heading, index) => {
      const item = items[index];
      if (!item) return;
      heading.id = item.id;
      heading.dataset.wikiOutlineHeading = "true";
      heading.classList.add("scroll-mt-24");
    });
    headingRefs.current = headings.slice(0, items.length);
    setActiveId(current => items.some(item => item.id === current) ? current : items[0]?.id ?? null);

    const scroller = root.closest<HTMLElement>("#workspace-scroll");
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const positions = headingRefs.current.map(heading => ({
          id: heading.id,
          top: heading.getBoundingClientRect().top,
        }));
        setActiveId(activeWikiOutlineId(positions));
      });
    };
    update();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [contentRef, items]);

  function jump(item: WikiOutlineItem) {
    setActiveId(item.id);
    setMobileOpen(false);
    const root = contentRef.current;
    const target = root?.ownerDocument.getElementById(item.id);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (root) scrollSourceTo(item, root);
    if (typeof history !== "undefined") history.replaceState(null, "", `#${item.id}`);
  }

  const list = (
    <nav aria-label="当前文档目录" className="min-h-0 flex-1 overflow-y-auto px-2 py-2 panel-scrollbar">
      {items.length === 0 ? (
        <p className="px-2 py-3 text-xs leading-relaxed text-zinc-400">添加一级、二级或三级标题后，这里会实时生成目录。</p>
      ) : items.map(item => (
        <button
          key={item.id}
          type="button"
          onClick={() => jump(item)}
          aria-current={activeId === item.id ? "location" : undefined}
          className={`block w-full rounded-md py-1.5 pr-2 text-left text-xs leading-snug transition-colors ${
            activeId === item.id
              ? "bg-sky-50 font-semibold text-sky-800"
              : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800"
          }`}
          style={{ paddingLeft: 8 + (item.level - 1) * 12 }}
        >
          {item.text}
        </button>
      ))}
    </nav>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="order-first xl:hidden inline-flex items-center gap-1.5 self-start rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 shadow-sm"
        aria-expanded={mobileOpen}
      >
        <NavigationIcon name="outline" />
        目录
      </button>

      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭目录"
          onClick={() => setMobileOpen(false)}
          className="xl:hidden panel-mobile-full fixed inset-x-0 z-[45] bg-zinc-950/35"
        />
      )}
      <aside className={`${mobileOpen ? "translate-x-0" : "translate-x-[110%]"} panel-mobile-full fixed right-0 z-[46] flex w-[min(300px,calc(100vw-24px))] flex-col overflow-hidden rounded-l-xl border border-zinc-200 bg-white shadow-2xl transition-transform xl:hidden`}>
        <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800"><NavigationIcon name="outline" />目录</span>
          <button type="button" onClick={() => setMobileOpen(false)} className="h-8 w-8 rounded-full text-lg text-zinc-500 hover:bg-zinc-100" aria-label="关闭目录">×</button>
        </div>
        {list}
      </aside>

      {desktopCollapsed ? (
        <button
          type="button"
          onClick={() => setDesktopCollapsed(false)}
          className="hidden xl:inline-flex sticky top-4 h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50"
          title="展开目录"
          aria-label="展开目录"
          aria-expanded="false"
        >
          <NavigationIcon name="outline" />
        </button>
      ) : (
        <aside className="hidden xl:flex sticky top-4 h-[calc(100vh-120px)] w-[208px] shrink-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800"><NavigationIcon name="outline" />目录</span>
            <button
              type="button"
              onClick={() => setDesktopCollapsed(true)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="收起目录"
              title="收起目录"
              aria-expanded="true"
            >
              →
            </button>
          </div>
          {list}
        </aside>
      )}
    </>
  );
}
