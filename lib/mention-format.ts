import { deserializeMention, serializeMention, type ContentMentionAttrs } from "./mention-types";
import type { JSONContent } from "@tiptap/react";

export function serializeAtMention(id: string | null, label: string): string {
  return id ? `@[${label}](uid:${id})` : `@${label}`;
}

export function parseAtMentionToken(token: string): { id: string | null; label: string } | null {
  const withId = token.match(/^@\[([^\]]+)\]\(uid:([^)]+)\)$/);
  if (withId) return { id: withId[2], label: withId[1] };
  const bare = token.match(/^@([\w一-鿿]+)$/);
  if (bare) return { id: null, label: bare[1] };
  return null;
}

export function parseLine(line: string): JSONContent[] {
  const CMENTION = String.raw`\[#[^\]\n]*\](?:\([^\s)"]+(?:\s+"[^"]*")?\))?`;
  const AT_WITH_ID = String.raw`@\[[^\]]+\]\(uid:[^)]+\)`;
  const AT = String.raw`@[\w一-鿿]+`;
  const parts = line.split(new RegExp(`(${CMENTION}|${AT_WITH_ID}|${AT})`));
  const nodes: JSONContent[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (/^\[#[^\]]+\]$/.test(part)) {
      const attrs = deserializeMention(part);
      if (attrs) { nodes.push({ type: "contentMention", attrs: { ...attrs, label: null } }); continue; }
    }
    const legacyM = part.match(/^\[#([^\]]*)\]\(([^\s)"]+)(?:\s+"([^"]*)")?\)$/);
    if (legacyM) {
      const [, label, href] = legacyM;
      const blockIdM = href.match(/#block-([^"?\s]+)/);
      if (blockIdM) {
        nodes.push({ type: "contentMention", attrs: { kind: "block", displayMode: "scene", id: blockIdM[1], aux: null, versionId: null, label } });
        continue;
      }
      nodes.push({ type: "text", text: `#${label}` });
      continue;
    }
    const am = parseAtMentionToken(part);
    if (am) { nodes.push({ type: "atMention", attrs: am }); continue; }
    nodes.push({ type: "text", text: part });
  }
  return nodes;
}

export function parseToDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => {
      const inline = parseLine(line);
      return { type: "paragraph", content: inline.length ? inline : undefined };
    }),
  };
}

export { serializeMention, type ContentMentionAttrs };
