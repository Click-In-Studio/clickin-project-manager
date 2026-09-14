import { describe, it, expect } from "vitest";
import { firstContentChar } from "@/components/shell/app-shell/first-content-char";

/** 头像缺省字：跳过开头的中英文标点取第一个实义字符，英文大写（#487 A1 从 AppShell.tsx 搬出）。 */
describe("firstContentChar", () => {
  it("跳过开头标点与空白", () => {
    expect(firstContentChar("《哈姆雷特》")).toBe("哈");
    expect(firstContentChar("  「夜奔」")).toBe("夜");
    expect(firstContentChar("(Untitled)")).toBe("U");
  });
  it("英文取首字母并大写", () => {
    expect(firstContentChar("hamlet")).toBe("H");
  });
  it("全是标点时退回原串首字符，空串为空", () => {
    expect(firstContentChar("…")).toBe("…");
    expect(firstContentChar("")).toBe("");
  });
});
