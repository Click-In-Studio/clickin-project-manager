import { describe, it, expect } from "vitest";
import { parseFrontmatter, FrontmatterError } from "@/lib/help/frontmatter";

// 手册 frontmatter 是刻意收窄的 yaml 子集（#531）：标量 / 行内数组 / 数字 / 布尔。
// 不支持的形态必须**报错带行号**而不是猜——作者靠 CI 的报错定位。

describe("parseFrontmatter：支持的子集", () => {
  it("标量、数字、布尔、行内数组、引号与行尾注释", () => {
    const { data, body } = parseFrontmatter([
      "---",
      "title: 创建 Cue 表   # 动宾短语",
      "order: 2",
      "draft: false",
      "routes: [cuelists, admin/templates]",
      "who: \"有「Cue 表管理」权限的成员\"",
      "note: '带 # 号的值'",
      "empty: []",
      "---",
      "",
      "## 正文",
    ].join("\n"));
    expect(data).toEqual({
      title: "创建 Cue 表", order: 2, draft: false,
      routes: ["cuelists", "admin/templates"],
      who: "有「Cue 表管理」权限的成员", note: "带 # 号的值", empty: [],
    });
    expect(body).toBe("\n## 正文");
  });

  it("裸值里的撇号是正文不是引号，行尾注释照样剥掉（AI review）", () => {
    const { data } = parseFrontmatter("---\nsummary: it's fine   # 说明\nwho: 有「Cue 表管理」权限的成员 # 谁能用\nnote: a#b 不是注释\n---\n");
    expect(data).toEqual({ summary: "it's fine", who: "有「Cue 表管理」权限的成员", note: "a#b 不是注释" });
  });

  it("引号串：内部 # 与撇号保留；引号没闭合时当裸值", () => {
    const { data } = parseFrontmatter("---\na: \"x # y\"\nb: 'it''s'\nc: \"未闭合 # 注释\n---\n");
    expect(data.a).toBe("x # y");
    expect(data.b).toBe("it''s");
    expect(data.c).toBe("\"未闭合");
  });

  it("行内数组按逗号硬切，不做引号感知（刻意不支持，值里不该有逗号）", () => {
    const { data } = parseFrontmatter("---\nroutes: [\"a, b\", c]\n---\n");
    expect(data.routes).toEqual(["\"a", "b\"", "c"]);
  });

  it("没有 frontmatter 块 → 空 data、全文为正文", () => {
    expect(parseFrontmatter("# 标题\n正文")).toEqual({ data: {}, body: "# 标题\n正文" });
  });

  it("frontmatter 内的空行与 # 注释行被忽略；BOM 与 CRLF 不影响", () => {
    const { data } = parseFrontmatter("﻿---\r\n# 说明\r\n\r\ntitle: x\r\n---\r\n正文");
    expect(data).toEqual({ title: "x" });
  });
});

describe("parseFrontmatter：不支持的形态报错带行号", () => {
  const cases: [string, string, number][] = [
    ["缩进块", "---\nroutes:\n  - a\n---\n", 3],
    ["重复字段", "---\ntitle: a\ntitle: b\n---\n", 3],
    ["非 key: value", "---\njust text\n---\n", 2],
    ["空值", "---\ntitle:\n---\n", 2],
    ["数组未闭合", "---\nroutes: [a, b\n---\n", 2],
    ["数组空项", "---\nroutes: [a, , b]\n---\n", 2],
    ["缺收尾 ---", "---\ntitle: a\n正文", 1],
  ];
  for (const [name, src, line] of cases) {
    it(name, () => {
      let err: unknown;
      try { parseFrontmatter(src); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(FrontmatterError);
      expect((err as FrontmatterError).line).toBe(line);
    });
  }
});
