"use client";

import SmartTextarea, { type MentionMember } from "./SmartTextarea";

export type { MentionMember };

export default function MarkdownEditor({
  content,
  onChange = () => {},
  onMentionsChange,
  members = [],
  productionId,
  versionId,
  placeholder = "写内容…",
  minHeight = 200,
  readOnly = false,
}: {
  content: string;
  onChange?: (md: string) => void;
  onMentionsChange?: (m: MentionMember[]) => void;
  members?: MentionMember[];
  productionId?: string;
  versionId?: string | null;
  placeholder?: string;
  minHeight?: number;
  readOnly?: boolean;
}) {
  return (
    <SmartTextarea
      value={content}
      onChange={onChange}
      markdown
      memberMention={members.length > 0 || onMentionsChange ? { members, onMentionsChange } : undefined}
      contentMention={productionId ? { productionId, versionId } : undefined}
      placeholder={placeholder}
      minHeight={minHeight}
      readOnly={readOnly}
    />
  );
}
