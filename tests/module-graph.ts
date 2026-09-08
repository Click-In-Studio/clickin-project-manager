import fs from "node:fs";
import path from "node:path";

/**
 * #416 把关测试共用的静态模块图工具。
 *
 * 单独抽出来是因为白名单把关和接线把关要用**同一份**闭包定义——两边各写一份，
 * 迟早会有一边漏跟某类 import，而漏跟的那类正好是出事的那类。
 */

export const ROOT = path.resolve(__dirname, "..");

const EXTS = [".tsx", ".ts"];

/** 解析一个 import specifier 到仓库相对路径；解析不到返回 null（第三方包等）。 */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.normalize(path.join(path.dirname(fromFile), spec));
  } else return null;

  for (const ext of EXTS) {
    if (fs.existsSync(path.join(ROOT, base + ext))) return base + ext;
  }
  for (const ext of EXTS) {
    const idx = path.join(base, "index" + ext);
    if (fs.existsSync(path.join(ROOT, idx))) return idx;
  }
  return null;
}

// 静态 import / export-from / 动态 import()——三种都要跟，漏一种就是一个盲区
const SPEC = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

/** 从若干入口出发的传递闭包（仓库相对路径）。 */
export function closure(entries: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    seen.add(f);
    const src = fs.readFileSync(abs, "utf8");
    for (const m of src.matchAll(SPEC)) {
      const r = resolveSpec(m[1], f);
      if (r) stack.push(r);
    }
  }
  return [...seen];
}

/** 括号配平地取出每个 fetch(...) 调用的实参文本与行号。 */
export function fetchCalls(src: string): { args: string; line: number }[] {
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
    out.push({ args: src.slice(re.lastIndex, j), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

const WRITE = /method\s*:\s*["'](POST|PATCH|PUT|DELETE)/i;

/**
 * 判断一个 fetch 调用是不是写请求。
 *
 * 两种形态都要认：实参里直接写 `{ method: "POST" }`，以及把 init 提出去存成变量再
 * `fetch(url, init)`——后者是第一版把关测试的盲区（AI review #3 指出）。
 */
export function isWriteCall(args: string, src: string): boolean {
  if (WRITE.test(args)) return true;
  const parts = args.split(",");
  if (parts.length < 2) return false;
  const second = parts[1].trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(second)) return false;
  // 找同文件里该变量的定义，看它带不带写 method
  const def = new RegExp(`\\b(?:const|let|var)\\s+${second}\\b[^;]*`, "s").exec(src);
  return def ? WRITE.test(def[0]) : false;
}

/** POST/PUT 形状但不改数据的端点——见 docs/DEV_GUIDE.md §10.5 的例外表。 */
export const NON_MUTATING = [
  "/mention-resolve", // 把 POST 当批量查询用，常在 useEffect 里；接了会 refresh→props 变→refresh 自激
  "/cue-presence",    // presence 心跳，定时打
  "/avatar/presign",  // 预签名；其后真正的 PATCH 自己会刷
  "/export-cues",     // 导出流，不改数据

  // agent 会话控制面：建会话 / 流式对话 / 中止 / 审批放行 / 回答提问 / 会话增删改。
  // 这些不写页面数据；agent **真正**改到的数据由 AgentPopout 的 useAgentMutation
  // 订阅兜底（没人接就 300ms 合并成一次 router.refresh()，见 AgentPopout.tsx:245），
  // 那才是 agent 写入的失效通道。给 /chat/stream 之类接上反而会每条消息刷一次整页。
  // 例外：/api/agent/instructions 是真数据写，已走 writeFetch。
  "/api/agent/sessions",
  "/api/agent/chat/stream",
  "/api/agent/chat/abort",
  "/api/agent/approval",
  "/api/agent/questions",
];

/**
 * 某文件里所有「不会失效 router cache」的写点，返回 `file:line` 列表。
 *
 * 只看客户端文件（带 "use client"）。服务端组件 / lib 里的 fetch（打飞书、打 R2）
 * 跑在服务端，压根不经过 client router cache，算进来全是噪音。
 */
export function bareWrites(file: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!/^\s*["']use client["']/m.test(src)) return [];
  const out: string[] = [];
  for (const { args, line } of fetchCalls(src)) {
    if (!isWriteCall(args, src)) continue;
    if (NON_MUTATING.some(e => args.includes(e))) continue;
    out.push(`${file}:${line}`);
  }
  return out;
}

/** 递归找出 app/ 下所有 page.tsx。 */
export function walkPages(dir = "app", acc: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walkPages(rel, acc);
    else if (e.name === "page.tsx") acc.push(rel);
  }
  return acc;
}
