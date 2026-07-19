// Shared types and serialization for content mentions (#-prefix)

export type ContentMentionKind = "page" | "scene" | "rehearsal" | "block" | "cue" | "asset";
export type BlockDisplayMode = "page" | "scene" | "rehearsal";

export type ContentMentionAttrs = {
  kind: ContentMentionKind;
  displayMode: BlockDisplayMode | null;
  id: string;
  aux: string | null;
  versionId: string | null;
};

// Returned by the block-search API
export type MentionSearchResult = {
  kind: ContentMentionKind;
  displayMode?: BlockDisplayMode;
  id: string;
  aux?: string;
  versionId?: string; // set when result is from an explicit version-prefix query
  displayLabel: string;
  description?: string;
};

// ── Serialization ──────────────────────────────────────────────────────────────

export function serializeMention(attrs: ContentMentionAttrs): string {
  const kindStr = attrs.kind === "block" && attrs.displayMode
    ? `block.${attrs.displayMode}`
    : attrs.kind;
  const idStr = attrs.versionId ? `${attrs.id}?v=${attrs.versionId}` : attrs.id;
  const auxStr = attrs.aux ? `:${attrs.aux}` : "";
  return `[#${kindStr}:${idStr}${auxStr}]`;
}

// Matches a single DB-format mention token in a larger string
export const MENTION_PATTERN = /\[#[^\]]+\]/g;

export function deserializeMention(token: string): ContentMentionAttrs | null {
  // Format: [#kind:id] or [#kind:id:aux] or [#block.mode:id]
  // The id may have ?v=versionId appended
  const m = token.match(/^\[#([^:]+):([^:\]]+)(?::([^\]]+))?\]$/);
  if (!m) return null;

  const kindStr = m[1];
  const idWithVersion = m[2];
  const aux = m[3] ?? null;

  let kind: ContentMentionKind;
  let displayMode: BlockDisplayMode | null = null;

  if (kindStr.startsWith("block.")) {
    kind = "block";
    displayMode = kindStr.slice(6) as BlockDisplayMode;
  } else {
    kind = kindStr as ContentMentionKind;
  }

  let id = idWithVersion;
  let versionId: string | null = null;
  const vMatch = idWithVersion.match(/^(.+)\?v=(.+)$/);
  if (vMatch) {
    id = vMatch[1];
    versionId = vMatch[2];
  }

  return { kind, displayMode, id, aux, versionId };
}

// ── MarkdownEditor href encoding ───────────────────────────────────────────────
// MarkdownEditor serializes contentMention as [#label](/__cm__<encoded>) markdown links.
// <encoded> = same format as the DB token inner content: kind:id[:aux][?v=verId]

export const CM_HREF_PREFIX = "/__cm__";

export function encodeMentionHref(attrs: ContentMentionAttrs): string {
  const kindStr = attrs.kind === "block" && attrs.displayMode
    ? `block.${attrs.displayMode}`
    : attrs.kind;
  const idStr = attrs.versionId ? `${attrs.id}?v=${attrs.versionId}` : attrs.id;
  const auxStr = attrs.aux ? `:${attrs.aux}` : "";
  return `${CM_HREF_PREFIX}${kindStr}:${idStr}${auxStr}`;
}

export function decodeMentionHref(href: string): ContentMentionAttrs | null {
  if (!href.startsWith(CM_HREF_PREFIX)) return null;
  return deserializeMention(`[#${href.slice(CM_HREF_PREFIX.length)}]`);
}

export function migrateLegacyRehearsalMentions(
  content: string,
  versionId: string,
  mappings: Array<{ sceneId: string; label: string; markerId: string }>,
  includeUnversioned: boolean,
): string {
  const markerIdByLegacyKey = new Map(
    mappings.map(({ sceneId, label, markerId }) => [`${sceneId}\u0000${label}`, markerId]),
  );
  const replacement = (sceneId: string, tokenVersionId: string | undefined, label: string) => {
    if (tokenVersionId ? tokenVersionId !== versionId : !includeUnversioned) return null;
    const markerId = markerIdByLegacyKey.get(`${sceneId}\u0000${label.toUpperCase()}`);
    return markerId ? `${markerId}${tokenVersionId ? `?v=${tokenVersionId}` : ""}` : null;
  };
  return content
    .replace(
      /\[#rehearsal:([^:?\]]+)(?:\?v=([^:\]]+))?:([A-Za-z]+)\]/g,
      (match, sceneId: string, tokenVersionId: string | undefined, label: string) => {
        const migrated = replacement(sceneId, tokenVersionId, label);
        return migrated ? `[#rehearsal:${migrated}]` : match;
      },
    )
    .replace(
      /\/__cm__rehearsal:([^:?)]+)(?:\?v=([^:)]+))?:([A-Za-z]+)\)/g,
      (match, sceneId: string, tokenVersionId: string | undefined, label: string) => {
        const migrated = replacement(sceneId, tokenVersionId, label);
        return migrated ? `${CM_HREF_PREFIX}rehearsal:${migrated})` : match;
      },
    );
}
