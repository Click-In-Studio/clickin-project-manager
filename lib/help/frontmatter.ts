// 使用手册（#531）的 frontmatter 解析：手册页是仓库里的 markdown，字段契约见
// docs/DEV_GUIDE.md §12。仓库没有 yaml 依赖，而手册只需要三种值——标量、
// 行内数组 `[a, b]`、数字——为此引一整个 yaml 解析器不值当；这里的子集是
// **刻意收窄的**，遇到缩进块、多行字符串、嵌套对象一律报错而不是猜，
// 让作者在 CI 的覆盖测试里看到明确的行号。

export type FrontmatterValue = string | number | boolean | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export class FrontmatterError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`frontmatter 第 ${line} 行：${message}`);
  }
}

const FENCE = "---";

/** 拆出 frontmatter 与正文。没有 frontmatter 块 → data 为空对象、body 为全文。 */
export function parseFrontmatter(source: string): { data: Frontmatter; body: string } {
  const text = source.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return { data: {}, body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === FENCE);
  if (end < 0) throw new FrontmatterError("缺少收尾的 ---", 1);
  const data: Frontmatter = {};
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (/^\s/.test(raw)) throw new FrontmatterError("不支持缩进块，数组请写成行内 [a, b]", i + 1);
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw);
    if (!m) throw new FrontmatterError(`不是 key: value 形态：${raw}`, i + 1);
    const [, key, valueRaw] = m;
    if (key in data) throw new FrontmatterError(`字段 ${key} 重复`, i + 1);
    const value = stripComment(valueRaw);
    // `routes:` 后面跟缩进的 `- a`：作者写的是 yaml 块数组，指着块的第一行报，比「值为空」好定位
    if (value === "" && i + 1 < end && /^\s+\S/.test(lines[i + 1])) {
      throw new FrontmatterError("不支持缩进块，数组请写成行内 [a, b]", i + 2);
    }
    data[key] = parseValue(value, i + 1);
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

/**
 * 行尾 ` # 注释`。只有**以引号开头**的值才按引号串处理（引号内的 # 不算注释）；
 * 裸值里的撇号（`summary: it's fine # 说明`）是正文，不是引号——否则它会把后面
 * 真正的注释一起吞进值里（AI review 指出）。
 */
function stripComment(v: string): string {
  const t = v.trim();
  const q = t[0];
  if (q === '"' || q === "'") {
    const close = t.indexOf(q, 1);
    if (close > 0) {
      const after = t.slice(close + 1).trim();
      if (after === "" || after.startsWith("#")) return t.slice(0, close + 1);
    }
    // 引号没闭合 / 闭合后还有非注释内容：当裸值处理，落到下面的规则
  }
  const m = /(^|\s)#/.exec(t);
  return (m ? t.slice(0, m.index) : t).trim();
}

function parseValue(v: string, line: number): FrontmatterValue {
  if (v === "") throw new FrontmatterError("值为空", line);
  if (v.startsWith("[")) {
    // 行内数组按逗号硬切，引号里的逗号不做特殊处理——手册数组只装 slug / 路由 /
    // 平台名，这些值不含逗号。刻意不做：做一半的引号感知比不做更难预测。
    if (!v.endsWith("]")) throw new FrontmatterError("数组没有闭合的 ]", line);
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => {
      const item = unquote(s.trim());
      if (item === "") throw new FrontmatterError("数组里有空项", line);
      return item;
    });
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return unquote(v);
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}
