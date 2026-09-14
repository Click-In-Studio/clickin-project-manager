import { mdToHtml, stagePairRegex } from "@/lib/script/script-md";
import { getTextBeforeCursor, setCursorAtTextOffset } from "./dom-cursor";

export function sanitizePasteNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(sanitizePasteNode).join("");
  switch (tag) {
    case "b": case "strong": return `<b>${inner}</b>`;
    case "u": return `<u>${inner}</u>`;
    case "br": return "<br>";
    case "span":
      if (el.hasAttribute("data-stage-inline"))
        return `<span data-stage-inline="" style="font-family:var(--font-stage);font-style:italic;color:#a1a1aa">${inner}</span>`;
      return inner;
    case "p": case "div": case "li":
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return inner ? inner + "<br>" : "";
    default: return inner;
  }
}

export function sanitizePasteHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return Array.from(tmp.childNodes).map(sanitizePasteNode).join("").replace(/<br>$/, "");
}

// ─── Markdown ↔ HTML conversion ───────────────────────────────────────────────
// Storage format: plain text with **bold** and __underline__ markers.
// Stage-inline cues are stored as plain bracketed text — no span markup.

export function nodeToMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(nodeToMd).join("");
  switch (tag) {
    case "b": case "strong": return `**${inner}**`;
    case "u": return `__${inner}__`;
    case "br": return "\n";
    case "span": return inner; // strip all spans (including stage-inline); brackets remain
    case "p": case "div": case "li":
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return inner ? inner + "\n" : "";
    default: return inner;
  }
}

export function htmlToMd(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return Array.from(tmp.childNodes).map(nodeToMd).join("").replace(/\n$/, "");
}




export function replaceInlineStageDelimiters(content: string, fromOpen: string, fromClose: string, toOpen: string, toClose: string): string {
  const pairRegex = stagePairRegex(fromOpen, fromClose);
  return content.replace(pairRegex, (match) =>
    `${toOpen}${match.slice(fromOpen.length, match.length - fromClose.length)}${toClose}`
  );
}

// Properly toggle a bold/underline tag on the given range:
// - If the common ancestor of the range is inside ONE existing tag element → unwrap it.
// - Otherwise → flatten any nested tags inside the range, wrap the whole range,
//   and restore the selection over the new wrapper so the next toggle works immediately.
export function toggleInlineTag(range: Range, tag: "b" | "u"): void {
  // commonAncestorContainer is inside the <b>/<u> whenever the selection is fully
  // within it — even when start/end containers land at the element boundary in the parent.
  const ancestor = range.commonAncestorContainer;
  const ancestorEl = ancestor.nodeType === Node.TEXT_NODE
    ? ancestor.parentElement
    : (ancestor as HTMLElement);
  const existingTag = ancestorEl?.closest(tag) ?? null;
  const sel = window.getSelection();

  // Helper: restore selection spanning first..last nodes.
  // Anchors to child nodes (text nodes or elements), NOT to the wrapper element,
  // so the range stays valid even if the wrapper is later removed by another toggle.
  const restoreSelection = (first: ChildNode, last: ChildNode) => {
    if (!sel) return;
    try {
      const r = document.createRange();
      r.setStart(first, 0);
      r.setEnd(
        last,
        last.nodeType === Node.TEXT_NODE
          ? (last.textContent?.length ?? 0)
          : (last as Element).childNodes.length
      );
      sel.removeAllRanges();
      sel.addRange(r);
    } catch { /* ignore stale-range errors */ }
  };

  if (existingTag) {
    const first = existingTag.firstChild;
    const last  = existingTag.lastChild;
    existingTag.replaceWith(...Array.from(existingTag.childNodes));
    if (first && last) restoreSelection(first, last);
    return;
  }

  const frag = range.extractContents();
  frag.querySelectorAll(tag).forEach(el => el.replaceWith(...Array.from(el.childNodes)));
  const wrapper = document.createElement(tag);
  wrapper.appendChild(frag);
  range.insertNode(wrapper);
  if (wrapper.firstChild && wrapper.lastChild)
    restoreSelection(wrapper.firstChild, wrapper.lastChild);
}

export function wrapSelectionAsInlineStageCue(
  range: Range,
  delimOpen: string,
  delimClose: string,
): void {
  const frag = range.extractContents();
  const tmp = document.createElement("div");
  tmp.appendChild(frag.cloneNode(true));
  const selectedMd = htmlToMd(tmp.innerHTML);
  if (selectedMd.includes("\n")) {
    const wrappedMd = selectedMd
      .split("\n")
      .map((line) => line ? `${delimOpen}${line}${delimClose}` : line)
      .join("\n");
    const html = mdToHtml(wrappedMd, delimOpen, delimClose);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const replacement = document.createDocumentFragment();
    while (wrapper.firstChild) replacement.appendChild(wrapper.firstChild);
    const last = replacement.lastChild;
    range.insertNode(replacement);

    const sel = window.getSelection();
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
    }
    return;
  }

  const span = document.createElement("span");
  span.setAttribute("data-stage-inline", "");
  span.style.fontFamily = "var(--font-stage)";
  span.style.fontStyle = "italic";
  span.style.color = "#a1a1aa";
  span.appendChild(document.createTextNode(delimOpen));
  span.appendChild(frag);
  span.appendChild(document.createTextNode(delimClose));
  range.insertNode(span);

  const sel = window.getSelection();
  const after = document.createRange();
  after.setStartAfter(span);
  after.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(after);
}

export function applyInlineStageStyling(div: HTMLDivElement, delimOpen = "（", delimClose = "）") {
  const sel = window.getSelection();
  let savedOffset: number | null = null;
  if (sel && sel.rangeCount && sel.isCollapsed && div.contains(sel.anchorNode)) {
    savedOffset = getTextBeforeCursor(div).length;
  }

  const isStageSpan = (el: Element) =>
    el.hasAttribute("data-stage-inline");

  const validStageText = (text: string) =>
    text.startsWith(delimOpen) &&
    text.endsWith(delimClose) &&
    text.length >= delimOpen.length + delimClose.length;

  // Remove spans whose content no longer forms a valid pair
  div.querySelectorAll("span[data-stage-inline]").forEach((span) => {
    if (!validStageText(span.textContent ?? "")) {
      const parent = span.parentNode!;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  div.normalize();

  // Wrap new delimiter patterns in text nodes outside existing spans
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node;
  while ((node = walker.nextNode())) {
    let el: Node | null = (node as Text).parentNode;
    let inside = false;
    while (el && el !== div) {
      if (el instanceof Element && isStageSpan(el)) { inside = true; break; }
      el = el.parentNode;
    }
    if (!inside) textNodes.push(node as Text);
  }

  const pairRegex = stagePairRegex(delimOpen, delimClose);

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? "";
    const matches: { start: number; end: number }[] = [];
    let m;
    pairRegex.lastIndex = 0;
    while ((m = pairRegex.exec(text)) !== null) matches.push({ start: m.index, end: m.index + m[0].length });
    if (!matches.length) continue;

    const parent = textNode.parentNode!;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const { start, end } of matches) {
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const span = document.createElement("span");
      span.setAttribute("data-stage-inline", "");
      span.style.fontFamily = "var(--font-stage)";
      span.style.fontStyle = "italic";
      span.style.color = "#a1a1aa";
      span.textContent = text.slice(start, end);
      frag.appendChild(span);
      last = end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, textNode);
  }

  if (savedOffset !== null) {
    setCursorAtTextOffset(div, savedOffset);
    // If cursor landed at the end of a stage-inline span, push it outside
    const s = window.getSelection();
    if (s && s.rangeCount && s.isCollapsed) {
      const r = s.getRangeAt(0);
      let el: Node | null = r.startContainer;
      while (el && el !== div) {
        if (el instanceof HTMLSpanElement && isStageSpan(el)) {
          const endR = document.createRange();
          endR.selectNodeContents(el);
          endR.collapse(false);
          if (r.compareBoundaryPoints(Range.START_TO_END, endR) >= 0) {
            const after = document.createRange();
            after.setStartAfter(el);
            after.collapse(true);
            s.removeAllRanges();
            s.addRange(after);
          }
          break;
        }
        el = el.parentNode;
      }
    }
  }
}
