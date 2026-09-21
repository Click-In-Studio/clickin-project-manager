/**
 * 门语境裸 grant 查询禁令（#604）。
 *
 * 病：owner 代码级旁路靠调用方自己写 `permCtx.isOwner || await hasGrant(...)`，
 * #228 / #246 两轮补漏后仍有几十个文件各写各的，漏 owner 的症状是「接口通但页面拒 /
 * 入口不亮」，每次都要线上撞出来才发现。
 *
 * 规则：`app/` 与 `components/` 下门语境一律 `hasEffectiveGrant` / `hasAnyEffectiveGrant`
 * （自带 owner 旁路）或 `requireGrantGate`。裸 `hasGrant` / `hasAnyGrant` /
 * `listGrantedResourceIds` 只允许在 `lib/` 内的判定核与 `*-perm.ts` 里出现
 * ——那两处不在本测试扫描范围。
 *
 * 历史：#609 起按文件记账、只降不升；#609 / #610 / 本批三轮清零后改为硬禁——
 * `app/` `components/` 下出现任何一处即红，也不许经 `import { hasGrant as x }` 改名绕过。
 * 真需要「能力票不给 owner 旁路」的场景，把判定下沉到 `lib/<域>/*-perm.ts` 并写注释。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

// 只剥注释不剥字符串：字符串 / 模板字面量里出现 `hasGrant(` 会被计入。目前全库没有这种写法；
// 撞上「报了但源码里找不到调用」先查这一条。
const BARE_CALL = /\b(?:hasGrant|hasAnyGrant|listGrantedResourceIds)\s*\(/g;
const ALIASED_IMPORT = /\b(?:hasGrant|hasAnyGrant|listGrantedResourceIds)\s+as\s+\w+/g;
const SCAN_ROOTS = ["app", "components"] as const;

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
      const src = stripComments(readFileSync(full, "utf8"));
      const rel = relative(process.cwd(), full);
      const calls = (src.match(BARE_CALL) ?? []).length;
      const aliases = (src.match(ALIASED_IMPORT) ?? []).length;
      if (calls > 0) out.push(`${rel}: ${calls} 处裸调用——改用 hasEffectiveGrant 族`);
      if (aliases > 0) out.push(`${rel}: 经 import 改名引入裸判定——同样禁止`);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(process.cwd(), root));
  return out;
}

describe("禁令：app/ components/ 下门语境不得出现裸 hasGrant / hasAnyGrant / listGrantedResourceIds", () => {
  it("零裸调用、零改名 import", () => {
    expect(findBareCalls()).toEqual([]);
  });
});
