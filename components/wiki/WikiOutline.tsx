"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import NavigationIcon from "@/components/shell/app-shell/NavigationIcon";
import styles from "@/components/wiki/WikiOutline.module.css";
import { activeWikiOutlineId, type WikiOutlineItem } from "@/lib/wiki/outline-types";

/** 源码没有标题 DOM，以相同字体和宽度测量换行后的标题位置。 */
function sourceHeadingPositions(items: WikiOutlineItem[], source: HTMLTextAreaElement) {
  const mirror = document.createElement("div");
  const css = getComputedStyle(source);
  for (const property of ["font", "line-height", "letter-spacing", "padding", "box-sizing", "tab-size"]) {
    mirror.style.setProperty(property, css.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", width: `${source.clientWidth}px`,
    whiteSpace: "pre-wrap", overflowWrap: "break-word", border: "none",
  });
  let offset = 0;
  const markers = items.map(item => {
    mirror.append(document.createTextNode(source.value.slice(offset, item.offset)));
    const marker = mirror.appendChild(document.createElement("span"));
    marker.textContent = source.value.slice(item.offset, item.endOffset);
    offset = item.endOffset;
    return marker;
  });
  document.body.append(mirror);
  const top = mirror.getBoundingClientRect().top;
  const positions = markers.map((marker, index) => ({
    id: items[index].id, top: marker.getBoundingClientRect().top - top,
  }));
  mirror.remove();
  return positions;
}

export default function WikiOutline({ items, contentRef }: {
  items: WikiOutlineItem[];
  contentRef: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const entryRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);
  const headingRefs = useRef<HTMLElement[]>([]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const scroller = root.closest<HTMLElement>("#workspace-scroll");
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!headingRefs.current.length) {
          const source = root.querySelector<HTMLTextAreaElement>("[data-wiki-source-editor]");
          if (source) setActiveId(activeWikiOutlineId(sourceHeadingPositions(items, source), source.scrollTop + 24));
          else setActiveId(items[0]?.id ?? null);
          return;
        }
        const atEnd = scroller && scroller.scrollHeight > scroller.clientHeight
          && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        setActiveId(atEnd ? headingRefs.current.at(-1)!.id : activeWikiOutlineId(headingRefs.current.map(heading => ({
          id: heading.id, top: heading.getBoundingClientRect().top,
        })), (scroller?.getBoundingClientRect().top ?? 0) + 24));
      });
    };
    const bindHeadings = () => {
      headingRefs.current = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3")).slice(0, items.length);
      headingRefs.current.forEach((heading, index) => {
        if (heading.id !== items[index].id) heading.id = items[index].id;
        if (heading.dataset.wikiOutlineHeading !== "true") heading.dataset.wikiOutlineHeading = "true";
      });
      update();
    };
    bindHeadings();
    // 编辑器延迟挂载、模式切换和标题编辑都会替换 DOM；不监听属性，避免锚点写入循环。
    const observer = new MutationObserver(bindHeadings);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resizeObserver?.observe(root);
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    root.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", update);
      root.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [contentRef, items]);

  function jump(item: WikiOutlineItem) {
    setActiveId(item.id);
    const root = contentRef.current;
    const target = headingRefs.current.find(heading => heading.id === item.id);
    if (target) {
      const scroller = root?.closest<HTMLElement>("#workspace-scroll");
      if (scroller) scroller.scrollTo({
        top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24,
        behavior: "instant",
      });
      else target.scrollIntoView({ behavior: "instant", block: "start" });
    } else if (root) {
      const source = root.querySelector<HTMLTextAreaElement>("[data-wiki-source-editor]");
      if (source) {
        source.focus({ preventScroll: true });
        source.setSelectionRange(item.offset, item.endOffset);
        const position = sourceHeadingPositions(items, source).find(heading => heading.id === item.id);
        source.scrollTop = (position?.top ?? 0) - 24;
        source.scrollIntoView({ behavior: "instant", block: "center" });
      }
    }
    history.replaceState(null, "", `#${item.id}`);
  }

  function close() {
    setOpen(false);
    requestAnimationFrame(() => entryRef.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open || !activeId) return;
    const nav = panelRef.current?.querySelector("nav");
    const current = nav?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!nav || !current) return;
    const top = current.offsetTop;
    if (top < nav.scrollTop) nav.scrollTop = top;
    else if (top + current.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = top + current.offsetHeight - nav.clientHeight;
    }
  }, [activeId, open, items]);

  return (
    <div className={styles.outline}>
      <button ref={entryRef} type="button" onClick={() => setOpen(true)} className={styles.entry}
        aria-label="展开目录" title="展开目录" aria-expanded={open} aria-controls={panelId} hidden={open}>
        <NavigationIcon name="outline" /><span>目录</span>
      </button>
      <aside ref={panelRef} id={panelId} hidden={!open} className={`${styles.panel} panel-mobile-full`}
        aria-label="正文目录"
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
        <div className={styles.header}>
          <span>目录</span>
          <button type="button" onClick={close} className={styles.close} aria-label="收起目录" title="收起目录">×</button>
        </div>
        <nav aria-label="当前文档目录" className={`${styles.list} panel-scrollbar`}>
          {items.length === 0 ? (
            <p className={styles.empty}>添加一级、二级或三级标题后，这里会实时生成目录。</p>
          ) : items.map(item => (
            <button key={item.id} type="button" onClick={() => jump(item)}
              aria-current={activeId === item.id ? "location" : undefined} title={item.text}
              className={styles.heading} style={{ paddingLeft: 6 + (item.level - 1) * 8 }}>
              {item.text}
            </button>
          ))}
        </nav>
      </aside>
    </div>
  );
}
