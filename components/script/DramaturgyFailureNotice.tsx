"use client";

import { useEffect, useRef, useState } from "react";

/** 短提示只占正文流；持久错误和恢复入口由实际操作区域负责。 */
export default function DramaturgyFailureNotice({ error, revision, context }: {
  error: string | null;
  revision: number;
  context: string;
}) {
  const [visible, setVisible] = useState(false);
  const previousContext = useRef(context);
  useEffect(() => {
    if (previousContext.current !== context) {
      previousContext.current = context;
      setVisible(false);
      return;
    }
    setVisible(!!error);
    if (!error) return;
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [error, revision, context]);

  return visible && error ? (
    <p role="alert" className="mb-3 break-words rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
      {error}。请查看原操作处的错误说明。
    </p>
  ) : null;
}
