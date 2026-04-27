"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  content: string;
  size?: "sm" | "base";
};

export default function Markdown({ content, size = "base" }: Props) {
  return (
    <div className={`prose prose-zinc max-w-none ${size === "sm" ? "prose-sm" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
