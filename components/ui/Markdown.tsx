"use client";

import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown as MarkdownExt } from "tiptap-markdown";

type Props = {
  content: string;
  size?: "sm" | "base";
};

export default function Markdown({ content, size = "base" }: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: [
      StarterKit,
      MarkdownExt.configure({ transformCopiedText: true }),
    ],
    content,
    editorProps: {
      attributes: {
        class: `prose prose-zinc max-w-none${size === "sm" ? " prose-sm" : ""}`,
      },
    },
  });

  useEffect(() => {
    editor?.commands.setContent(content);
  }, [editor, content]);

  return <EditorContent editor={editor} />;
}
