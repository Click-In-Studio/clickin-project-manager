import { Mark, mergeAttributes, type Editor } from "@tiptap/core";

export const RICH_STYLE_HREF_PREFIX = "/__rs__/";

export type RichStyleAttrs = {
  underline: boolean;
  color: string | null;
  backgroundColor: string | null;
};

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const TEXT_COLORS = ["#18181b", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#7c3aed"] as const;
export const BACKGROUND_COLORS = ["#ffffff", "#fee2e2", "#ffedd5", "#fef9c3", "#dcfce7", "#dbeafe", "#ede9fe"] as const;

export function encodeRichStyleHref(attrs: Partial<RichStyleAttrs>): string {
  const params = new URLSearchParams();
  if (attrs.underline) params.set("u", "1");
  if (attrs.color && COLOR_RE.test(attrs.color)) params.set("fg", attrs.color.toLowerCase());
  if (attrs.backgroundColor && COLOR_RE.test(attrs.backgroundColor)) params.set("bg", attrs.backgroundColor.toLowerCase());
  return `${RICH_STYLE_HREF_PREFIX}?${params.toString()}`;
}

export function decodeRichStyleHref(href: string): RichStyleAttrs | null {
  if (!href.startsWith(RICH_STYLE_HREF_PREFIX)) return null;
  const params = new URL(href, "http://local").searchParams;
  const color = params.get("fg");
  const backgroundColor = params.get("bg");
  const attrs = {
    underline: params.get("u") === "1",
    color: color && COLOR_RE.test(color) ? color.toLowerCase() : null,
    backgroundColor: backgroundColor && COLOR_RE.test(backgroundColor) ? backgroundColor.toLowerCase() : null,
  };
  return attrs.underline || attrs.color || attrs.backgroundColor ? attrs : null;
}

export function richStyleCss(attrs: Partial<RichStyleAttrs>): string {
  return [
    attrs.underline ? "text-decoration:underline" : "",
    attrs.color ? `color:${attrs.color}` : "",
    attrs.backgroundColor ? `background-color:${attrs.backgroundColor}` : "",
  ].filter(Boolean).join(";");
}

export function updateRichStyle(editor: Editor, patch: Partial<RichStyleAttrs>): boolean {
  const current = editor.getAttributes("richStyle") as Partial<RichStyleAttrs>;
  const next: RichStyleAttrs = {
    underline: patch.underline ?? !!current.underline,
    color: patch.color === undefined ? current.color ?? null : patch.color,
    backgroundColor: patch.backgroundColor === undefined ? current.backgroundColor ?? null : patch.backgroundColor,
  };
  const chain = editor.chain().focus();
  if (!next.underline && !next.color && !next.backgroundColor) return chain.unsetMark("richStyle").run();
  return chain.setMark("richStyle", next).run();
}

export const RichStyle = Mark.create({
  name: "richStyle",
  priority: 1100,

  addAttributes() {
    return {
      underline: { default: false },
      color: { default: null },
      backgroundColor: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: `a[href^="${RICH_STYLE_HREF_PREFIX}"]`,
        priority: 1100,
        getAttrs: (element) => decodeRichStyleHref((element as HTMLElement).getAttribute("href") ?? "") ?? false,
      },
      {
        tag: "span[data-rich-style]",
        getAttrs: (element) => ({
          underline: (element as HTMLElement).dataset.underline === "true",
          color: (element as HTMLElement).dataset.color || null,
          backgroundColor: (element as HTMLElement).dataset.backgroundColor || null,
        }),
      },
    ];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const attrs = mark.attrs as RichStyleAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-rich-style": "",
        "data-underline": String(attrs.underline),
        "data-color": attrs.color ?? "",
        "data-background-color": attrs.backgroundColor ?? "",
        style: richStyleCss(attrs),
      }),
      0,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: "[",
          close: (_state: unknown, mark: { attrs: RichStyleAttrs }) => `](${encodeRichStyleHref(mark.attrs)})`,
        },
        parse: {},
      },
    };
  },
});
