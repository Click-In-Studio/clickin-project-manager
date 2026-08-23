/**
 * 金额换算的语义锁。
 *
 * 这个模块存在的唯一理由是「不要用 Number 算钱」。所以第一条测试就是把
 * 浮点做法的失败摆出来——它不是假想，而是 NUMERIC(14,2) 合法范围内的真实取值。
 */
import { describe, it, expect } from "vitest";
import { toCents, sumCents, fmtCny, pctUsed, pctCents } from "@/lib/money";

describe("1. 为什么不能用 Number 算钱", () => {
  it("NUMERIC(14,2) 的上限值过 Number 会丢掉一分，过 toCents 不会", () => {
    const top = "99999999999999.99";           // 12 位整数 + 2 位小数，AMOUNT_RE 允许
    expect(Math.round(Number(top) * 100)).toBe(9999999999999998);  // ← 少了一分
    expect(toCents(top)).toBe(BigInt("9999999999999999"));         // ← 分毫不差
  });

  it("合计不会长出浮点尾巴", () => {
    const parts = Array.from({ length: 10 }, () => "0.10");
    expect(fmtCny(sumCents(parts))).toBe("¥1");
    // 浮点写法在这里会得到 0.9999999999999999
    expect(Array.from({ length: 10 }, () => 0.1).reduce((a, b) => a + b)).not.toBe(1);
  });
});

describe("2. toCents 的解析", () => {
  it("整数 / 一位小数 / 两位小数都对", () => {
    expect(toCents("1234")).toBe(BigInt(123400));
    expect(toCents("1234.5")).toBe(BigInt(123450));
    expect(toCents("1234.56")).toBe(BigInt(123456));
    expect(toCents("0")).toBe(BigInt(0));
  });

  it("负数（超支差额）保号", () => {
    expect(toCents("-12.34")).toBe(BigInt(-1234));
  });

  it("脏值返回 0 而不是抛——一行坏数据不该炸掉整页财务", () => {
    expect(toCents("abc")).toBe(BigInt(0));
    expect(toCents("")).toBe(BigInt(0));
  });
});

describe("3. fmtCny 的展示", () => {
  it("千分位 + 整数金额省掉小数位", () => {
    expect(fmtCny(toCents("750000.00"))).toBe("¥750,000");
    expect(fmtCny(toCents("8600"))).toBe("¥8,600");
    expect(fmtCny(toCents("1234.56"))).toBe("¥1,234.56");
    expect(fmtCny(toCents("0.05"))).toBe("¥0.05");
    expect(fmtCny(toCents("0"))).toBe("¥0");
  });

  it("负号在 ¥ 之外（-¥12.34，不是 ¥-12.34）", () => {
    expect(fmtCny(toCents("-12.34"))).toBe("-¥12.34");
  });

  it("超支：可用余额为负能正常显示", () => {
    const budget = sumCents(["100.00"]), spent = sumCents(["130.50"]);
    expect(fmtCny(budget - spent)).toBe("-¥30.50");
  });
});

describe("4. 百分比", () => {
  it("常规取整", () => {
    expect(pctUsed("72400.00", "120000.00")).toBe(60);
    expect(pctUsed("43200.00", "160000.00")).toBe(27);
  });

  it("预算为 0 时返回 0，不是 NaN / Infinity", () => {
    expect(pctUsed("100.00", "0.00")).toBe(0);
    expect(pctCents(BigInt(1), BigInt(0))).toBe(0);
  });

  it("超支时返回大于 100（封顶是展示层的事，不在这里做）", () => {
    expect(pctUsed("150.00", "100.00")).toBe(150);
  });
});
