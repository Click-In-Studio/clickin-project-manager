"use client";

import SmartText from "./SmartText";

export default function MarkdownView({ content, className }: { content: string; className?: string }) {
  return <SmartText content={content} markdown className={className} />;
}
