/**
 * 门语境裸 grant 查询禁令（#604）。
 *
 * 病：owner 代码级旁路靠调用方自己写 `permCtx.isOwner || await hasGrant(...)`，
 * #228 / #246 两轮补漏后仍有几十个文件各写各的，漏 owner 的症状是「接口通但页面拒 /
 * 入口不亮」，每次都要线上撞出来才发现。
 *
 * 规则：门语境一律 `hasEffectiveGrant` / `hasAnyEffectiveGrant`（自带 owner 旁路）或
 * `requireGrantGate`。裸 `hasGrant` / `hasAnyGrant` / `listGrantedResourceIds` 只允许在
 * 下面 `LIB_ALLOWLIST` 列的判定核里出现——那些文件每个函数顶端自己写旁路（或刻意不旁路
 * 并在调用处注释了原因）。
 *
 * 历史：#609 起按文件记账、只降不升；#609 / #610 / #611 三轮把 `app/` `components/`
 * 清零后改为硬禁，#604 收尾批把 `lib/` 也纳入扫描（白名单之外即红）。不许经
 * `import { hasGrant as x }` 改名绕过。真需要「能力票不给 owner 旁路」的场景，把判定
 * 下沉到白名单里的 `lib/<域>/perm.ts` 并写注释；要加白名单文件，PR 里说明为什么。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

// 只剥注释不剥字符串：字符串 / 模板字面量里出现 `hasGrant(` 会被计入。目前全库没有这种写法；
// 撞上「报了但源码里找不到调用」先查这一条。
const BARE_CALL = /\b(?:hasGrant|hasAnyGrant|listGrantedResourceIds)\s*\(/g;
const ALIASED_IMPORT = /\b(?:hasGrant|hasAnyGrant|listGrantedResourceIds)\s+as\s+\w+/g;
const SCAN_ROOTS = ["app", "components", "lib"] as const;

/**
 * 判定核白名单。只减不加（加要在 PR 里说明）。
 * 白名单不是免检：下面第二条用例对每个白名单文件逐函数扫——凡是有裸调用的函数，要么在
 * 第一处裸调用之前读过 `isOwner`（顶端旁路），要么函数体内有 `#604 刻意不旁路` 标记并
 * 说明理由。两个 `lib/perm/*` 核心文件是判定的实现本身（hasGrant 定义 / 六步链把旁路放
 * 在 decideNode 里），豁免逐函数扫。
 */
const LIB_ALLOWLIST = new Set([
  "lib/perm/grant-check.ts",      // hasGrant 族本体
  "lib/perm/grant-template.ts",   // canAccessNode 六步链，第 1 步旁路在 decideNode
  "lib/perm/api-guard.ts",        // requireGrantGate，旁路在循环前
  "lib/asset/perm.ts",
  "lib/wiki/perm.ts",
  "lib/script/script-perm.ts",
  "lib/ops/event-permissions.ts",
  "lib/node/perm.ts",
  "lib/node/host-visibility.ts",  // 让渡：旁路在各内容域判定顶端，本函数不重复
  "lib/approval/approval-routing.ts", // holdsRequestedRows 问「持不持有行」不是门
]);
const STRUCTURE_EXEMPT = new Set(["lib/perm/grant-check.ts", "lib/perm/grant-template.ts"]);
const NO_BYPASS_MARKER = "#604 刻意不旁路";

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function findBareCalls(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const rel = relative(process.cwd(), full);
      if (LIB_ALLOWLIST.has(rel)) continue;
      const src = stripComments(readFileSync(full, "utf8"));
      const calls = (src.match(BARE_CALL) ?? []).length;
      const aliases = (src.match(ALIASED_IMPORT) ?? []).length;
      if (calls > 0) out.push(`${rel}: ${calls} 处裸调用——改用 hasEffectiveGrant 族`);
      if (aliases > 0) out.push(`${rel}: 经 import 改名引入裸判定——同样禁止`);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(process.cwd(), root));
  return out;
}

/**
 * 白名单文件逐函数扫：按 `function <name>` 切块（箭头函数归属于包裹它的具名函数），
 * 每块里若有裸调用，第一处裸调用之前必须读过 `.isOwner`，否则必须带刻意不旁路标记。
 * 注释不剥——标记就在注释里；`isOwner` 出现在注释里也算，够用（写注释骗过它的人自己负责）。
 */
function auditAllowlistedFile(rel: string): string[] {
  const src = readFileSync(join(process.cwd(), rel), "utf8");
  const heads = [...src.matchAll(/\bfunction\s+(\w+)/g)];
  const problems: string[] = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index!;
    const end = i + 1 < heads.length ? heads[i + 1].index! : src.length;
    const body = src.slice(start, end);
    const firstCall = body.search(BARE_CALL_ONE);
    if (firstCall < 0) continue;
    if (body.includes(NO_BYPASS_MARKER)) continue;
    if (/\.isOwner\b/.test(body.slice(0, firstCall))) continue;
    problems.push(`${rel} ${heads[i][1]}(): 裸调用前没有 owner 旁路，也没有「${NO_BYPASS_MARKER}」标记`);
  }
  return problems;
}
const BARE_CALL_ONE = /\b(?:hasGrant|hasAnyGrant|listGrantedResourceIds)\s*\(/;

describe("禁令：判定核白名单之外不得出现裸 hasGrant / hasAnyGrant / listGrantedResourceIds", () => {
  it("零裸调用、零改名 import", () => {
    expect(findBareCalls()).toEqual([]);
  });

  it("白名单文件逐函数：裸调用前有 owner 旁路，或带刻意不旁路标记", () => {
    const problems: string[] = [];
    for (const f of LIB_ALLOWLIST) {
      // 文件不存在也红：删了文件要同步从白名单去掉
      expect(() => readFileSync(join(process.cwd(), f)), f).not.toThrow();
      if (STRUCTURE_EXEMPT.has(f)) continue;
      problems.push(...auditAllowlistedFile(f));
    }
    expect(problems).toEqual([]);
  });
});
