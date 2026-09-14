export function getTextBeforeCursor(div: HTMLDivElement): string {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return "";
  const r = document.createRange();
  r.setStart(div, 0);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  const tmp = document.createElement("div");
  tmp.appendChild(r.cloneContents());
  return tmp.innerText;
}

export function getTextAfterCursor(div: HTMLDivElement): string {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return "";
  const r = document.createRange();
  r.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  r.setEnd(div, div.childNodes.length);
  const tmp = document.createElement("div");
  tmp.appendChild(r.cloneContents());
  return tmp.innerText;
}

export function isAtStart(div: HTMLDivElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = document.createRange();
  r.setStart(div, 0);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length === 0;
}

export function isOnFirstLine(div: HTMLDivElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  // Fallback for browsers that return a zero rect for collapsed ranges
  if (rect.height === 0) return !getTextBeforeCursor(div).includes("\n");
  return rect.top <= div.getBoundingClientRect().top + rect.height;
}

export function isOnLastLine(div: HTMLDivElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.height === 0) return !getTextAfterCursor(div).includes("\n");
  return rect.bottom >= div.getBoundingClientRect().bottom - rect.height;
}

export function getHtmlSplit(div: HTMLDivElement): { before: string; after: string } {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return { before: div.innerHTML, after: "" };
  const range = sel.getRangeAt(0);
  const t1 = document.createElement("div");
  const r1 = document.createRange();
  r1.setStart(div, 0);
  r1.setEnd(range.startContainer, range.startOffset);
  t1.appendChild(r1.cloneContents());
  const t2 = document.createElement("div");
  const r2 = document.createRange();
  r2.setStart(range.endContainer, range.endOffset);
  r2.setEnd(div, div.childNodes.length);
  t2.appendChild(r2.cloneContents());
  return { before: t1.innerHTML, after: t2.innerHTML };
}

export function setCursorAtStart(div: HTMLDivElement) {
  const r = document.createRange();
  r.setStart(div, 0);
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

export function setCursorAtEnd(div: HTMLDivElement) {
  const r = document.createRange();
  r.selectNodeContents(div);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

export function setCursorAtTextOffset(div: HTMLDivElement, target: number) {
  // Walk both text nodes and <br> elements. <br> counts as 1 character (same
  // as the \n it represents in innerText / mdToHtml output).
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_ALL, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR")
        return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    },
  });
  const sel = window.getSelection();
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.ELEMENT_NODE) {
      // BR element: counts as 1 character
      if (offset + 1 > target) {
        // target <= offset: the position is before this BR.
        // Place the cursor right before the BR element.
        const r = document.createRange();
        r.setStartBefore(node);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
        return;
      }
      offset += 1;
      if (offset === target) {
        // Position right after the BR (= start of the next line)
        const r = document.createRange();
        r.setStartAfter(node);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
        return;
      }
    } else {
      const textNode = node as Text;
      if (offset + textNode.length >= target) {
        const r = document.createRange();
        r.setStart(textNode, target - offset);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
        return;
      }
      offset += textNode.length;
    }
  }
  setCursorAtEnd(div);
}

export function getEditableElementForRange(range: Range): HTMLElement | null {
  let node: Node | null = range.commonAncestorContainer;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).isContentEditable) {
      return node as HTMLElement;
    }
    node = node.parentNode;
  }
  return null;
}

export function eventTargetElement(target: EventTarget | null): HTMLElement | null {
  const node = target instanceof Node ? target : null;
  return node instanceof HTMLElement
    ? node
    : node?.parentElement ?? null;
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element) return false;
  return !!element.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']");
}

export function isFormEditingTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  return !!element?.closest("input, textarea, select");
}

export function getTextLength(html: string): number {
  if (!html) return 0;
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.innerText.length;
}
