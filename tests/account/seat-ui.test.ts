/**
 * 席位展示口径（#313，lib/account/seat-ui.ts）：纯函数、进客户端包。
 * 阈值是 UX 契约——used === limit 即满、≥ ceil(80%) 提醒、超余量只说后果不拦。
 */
import { describe, it, expect } from "vitest";
import { seatTone, seatsRemaining, seatHint, seatOverflowHint } from "@/lib/account/seat-ui";

describe("seatTone", () => {
  it("free 档 limit 10：7 ok、8 warn、10 full；超编也是 full", () => {
    expect(seatTone({ used: 7, limit: 10 })).toBe("ok");
    expect(seatTone({ used: 8, limit: 10 })).toBe("warn");
    expect(seatTone({ used: 9, limit: 10 })).toBe("warn");
    expect(seatTone({ used: 10, limit: 10 })).toBe("full");
    expect(seatTone({ used: 11, limit: 10 })).toBe("full");
  });

  it("非整数阈值向上取整：limit 3 → 80% = 2.4 → 3 才算 warn，但 3 已是 full", () => {
    expect(seatTone({ used: 2, limit: 3 })).toBe("ok");
    expect(seatTone({ used: 3, limit: 3 })).toBe("full");
  });

  it("pro 档 limit 200：160 起 warn", () => {
    expect(seatTone({ used: 159, limit: 200 })).toBe("ok");
    expect(seatTone({ used: 160, limit: 200 })).toBe("warn");
  });
});

describe("seatsRemaining", () => {
  it("不会为负", () => {
    expect(seatsRemaining({ used: 3, limit: 10 })).toBe(7);
    expect(seatsRemaining({ used: 12, limit: 10 })).toBe(0);
  });
});

describe("seatHint", () => {
  it("充裕时 null，不打扰", () => {
    expect(seatHint({ used: 1, limit: 10 })).toBeNull();
  });
  it("将满给余量、满员给自解路径（确认离组 / 升档）", () => {
    expect(seatHint({ used: 8, limit: 10 })).toBe("席位余量 2（8 / 10）");
    const full = seatHint({ used: 10, limit: 10 })!;
    expect(full).toContain("席位已满（10 / 10）");
    expect(full).toContain("确认离组");
    expect(full).toContain("升级项目档位");
  });
});

describe("seatOverflowHint", () => {
  it("未超余量 null；恰好用完也不提示", () => {
    expect(seatOverflowHint({ used: 8, limit: 10 }, 1)).toBeNull();
    expect(seatOverflowHint({ used: 8, limit: 10 }, 2)).toBeNull();
  });
  it("超余量只说后果：先接受先进、超出的 N 位会被拒", () => {
    expect(seatOverflowHint({ used: 8, limit: 10 }, 5)).toBe(
      "席位余量 2，本次将发出 5 份邀请：先接受的先进，超出的 3 位接受时会被拒",
    );
  });
});
