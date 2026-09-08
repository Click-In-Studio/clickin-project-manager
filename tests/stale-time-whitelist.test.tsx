import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * #416 白名单把关。
 *
 * 页面导出 `unstable_dynamicStaleTime` 就等于宣称：**本页自己能触发的写操作，全部
 * 会失效 client router cache**。否则用户在本页写完切走、30 秒内切回来，组件会从写
 * 之前的 RSC payload 重新播种（`useState(initialX)` 的播种模式全仓遍地都是），自己
 * 的写被静默打回。
 *
 * 这条测试自己去发现白名单（扫 app/ 下带该导出的 page），再算它的组件闭包，断言闭包
 * 里没有裸的写 fetch。所以：往白名单页面的组件树里塞一个裸 fetch 写点，这里会红；
 * 新页面加上那个导出而组件没收拾干净，这里也会红。
 */

const ROOT = path.resolve(__dirname, "..");

/** POST/PUT 形状但不改数据的端点——它们不该触发 refresh，见 AGENTS.md 的例外表。 */
const NON_MUTATING = [
  "/mention-resolve",   // 把 POST 当批量查询用，常在 useEffect 里；接了会 refresh→props 变→refresh 自激
  "/cue-presence",      // presence 心跳，定时打
  "/avatar/presign",    // 预签名；其后真正的 PATCH 自己会刷
  "/export-cues",       // 导出流，不改数据
];

const WRITE = /method\s*:\s*["'](POST|PATCH|PUT|DELETE)/i;
const IMPORT = /from "(@\/(?:components|hooks)\/[A-Za-z0-9_/\-.]+)"/g;

function resolveModule(spec: string): string | null {
  const rel = spec.replace("@/", "");
  for (const ext of [".tsx", ".ts"]) {
    const p = path.join(ROOT, rel + ext);
    if (fs.existsSync(p)) return rel + ext;
  }
  return null;
}

/** 括号配平地取出每个 fetch(...) 的实参文本。 */
function fetchCalls(src: string): { args: string; line: number }[] {
  const out: { args: string; line: number }[] = [];
  const re = /(?<![\w.$])fetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    // re.lastIndex 停在 "(" 之后，回退一格就是那个左括号
    let j = re.lastIndex - 1;
    while (j < src.length) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    out.push({
      args: src.slice(re.lastIndex, j),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

function closure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    seen.add(f);
    const src = fs.readFileSync(abs, "utf8");
    for (const m of src.matchAll(IMPORT)) {
      const r = resolveModule(m[1]);
      if (r) stack.push(r);
    }
  }
  return [...seen];
}

function walkPages(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walkPages(rel, acc);
    else if (e.name === "page.tsx") acc.push(rel);
  }
  return acc;
}

const whitelisted = walkPages("app").filter(p =>
  /export const unstable_dynamicStaleTime\s*=/.test(fs.readFileSync(path.join(ROOT, p), "utf8")),
);

describe("#416 staleTime 白名单", () => {
  it("白名单非空——否则这条测试是在空转", () => {
    expect(whitelisted.length).toBeGreaterThan(0);
  });

  it.each(whitelisted)("%s：组件闭包内没有未失效缓存的写点", (page) => {
    const offenders: string[] = [];
    for (const file of closure(page)) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const { args, line } of fetchCalls(src)) {
        if (!WRITE.test(args)) continue;
        if (NON_MUTATING.some(e => args.includes(e))) continue;
        offenders.push(`${file}:${line}`);
      }
    }
    expect(
      offenders,
      `这些写点用的是裸 fetch，不会失效 client router cache。\n` +
        `该页导出了 unstable_dynamicStaleTime，用户在本页写完切走再切回来会被打回。\n` +
        `改用 @/lib/write-refresh 的 writeFetch，或把该页从白名单里摘掉。\n` +
        `涉及：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
