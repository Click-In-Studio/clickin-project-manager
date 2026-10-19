import { describe, expect, it } from "vitest";
import { attachmentReferences } from "@/lib/agent/chat/attachment-references";

describe("聊天与历史共用的附件引用", () => {
  it("完整引用恢复身份与说明，重复引用保留各自展示 key", () => {
    expect(attachmentReferences("说明 [[attachment:a_one| 舞台参考 ]] [[attachment:a_one]]")).toEqual({
      text: "说明", items: [
        { id: "a_one", alt: "舞台参考", key: "a_one:0" },
        { id: "a_one", alt: "", key: "a_one:1" },
      ],
    });
  });
  it("流式未完成、换行或超长说明都保持原文，不提前读取附件元数据", () => {
    for (const text of ["[[attachment:a_one", "[[attachment:a_one|未完成", "[[attachment:a_one|跨\n行]]", `[[attachment:a_one|${"x".repeat(201)}]]`]) {
      expect(attachmentReferences(text)).toEqual({ text, items: [] });
    }
  });
});
