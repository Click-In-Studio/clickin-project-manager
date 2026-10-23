"use client";

import { memo, useEffect, useRef, useState } from "react";
import StreamingWikiMarkdown from "@/components/wiki/StreamingWikiMarkdown";

/** 只缓冲正文快照，不延迟工具事件、停止或确认卡；切会话由宿主消息 key 隔离。 */
export default memo(function ChatMarkdown({ content, streaming, productionId }: {
  content: string; streaming: boolean; productionId?: string;
}) {
  const [visible, setVisible] = useState(content);
  const latest = useRef(content);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = content;
  useEffect(() => {
    if (!streaming) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setVisible(content);
      return;
    }
    if (content !== visible && timer.current === null) {
      timer.current = setTimeout(() => { timer.current = null; setVisible(latest.current); }, 50);
    }
  }, [content, streaming, visible]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <StreamingWikiMarkdown content={streaming ? visible : content} streaming={streaming} productionId={productionId} />;
});
