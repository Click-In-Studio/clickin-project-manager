/**
 * 发版：把 content/changelog/unreleased/ 里的条目卷成一个版本目录（#569）。
 *
 *   npm run changelog:release -- v0.2
 *
 * 做的事：
 *   1. 校验 tag 形态、版本目录不存在、unreleased/ 非空、内容加载得过（同 CI 的校验）
 *   2. 建 content/changelog/<tag>/_index.md（date = 今天）
 *   3. 把 unreleased/*.md 移进去（git mv 保留历史；不在 git 里就普通 rename）
 * 之后**人来编辑**：重排、合并、删掉太细的、补截图——脚本只搬运不措辞。
 * 编辑完 commit，再 `git tag <tag> && git push origin <tag>`。deploy.yml 在 tag 发布时
 * 会校验 content/changelog/<tag>/_index.md 存在，没有就红——不许发一个没交代的版本。
 *
 *   --allow-empty   这一版确实没有用户可感知改动（纯内部）时也建目录，页面上会显示
 *                   「这一版没有你能感知到的改动」
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadChangelog, CHANGELOG_ROOT, CHANGELOG_UNRELEASED_DIR, CHANGELOG_VERSION_RE } from "../lib/help/changelog";

const args = process.argv.slice(2);
const allowEmpty = args.includes("--allow-empty");
const tag = args.find((a) => !a.startsWith("--"));

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!tag) fail("用法：npm run changelog:release -- v0.2 [--allow-empty]");
if (!CHANGELOG_VERSION_RE.test(tag)) fail(`版本号要是 tag 形态（v0.2 / v0.1.0），收到 ${tag}`);

const versionDir = path.join(CHANGELOG_ROOT, tag);
const unreleasedDir = path.join(CHANGELOG_ROOT, CHANGELOG_UNRELEASED_DIR);
if (existsSync(versionDir)) fail(`content/changelog/${tag}/ 已存在——这个版本已经发过，或者你要的是下一个号`);

// 先让加载器过一遍：frontmatter 错在这里就拦住，别搬进版本目录再红
const log = loadChangelog();
if (log.versions.some((v) => v.version === tag)) fail(`${tag} 已在版本列表里`);
if (log.unreleased.length === 0 && !allowEmpty) {
  fail("unreleased/ 里没有条目。真是纯内部版本就加 --allow-empty；否则先按 content/changelog/_TEMPLATE.md 补条目");
}

const files = readdirSync(unreleasedDir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
const today = new Date().toISOString().slice(0, 10);

mkdirSync(versionDir);
writeFileSync(path.join(versionDir, "_index.md"), `---\ndate: ${today}\n---\n`, "utf8");

const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" }).status === 0;
for (const f of files) {
  const from = path.join(unreleasedDir, f);
  const to = path.join(versionDir, f);
  const tracked = inGit && spawnSync("git", ["ls-files", "--error-unmatch", from], { stdio: "ignore" }).status === 0;
  if (tracked) {
    const r = spawnSync("git", ["mv", from, to], { stdio: "inherit" });
    if (r.status !== 0) fail(`git mv ${f} 失败`);
  } else {
    renameSync(from, to);
  }
}

// 搬完再加载一次：版本目录必须能被读出来
const after = loadChangelog();
const made = after.versions.find((v) => v.version === tag);
if (!made) fail("搬完后加载不到新版本——请检查目录");

console.log(`✓ content/changelog/${tag}/  ${made.date}  ${made.entries.length} 条`);
for (const e of made.entries) console.log(`   [${e.kind}] ${e.title}`);
console.log(`
下一步：
  1. 打开 content/changelog/${tag}/ 逐条过目：重排（order）、合并、删掉太细的、补一句 summary 到 _index.md
  2. npx vitest run tests/help/changelog.test.ts
  3. git add content/changelog && git commit -m "docs(changelog): ${tag}"
  4. git tag ${tag} && git push origin main ${tag}`);
