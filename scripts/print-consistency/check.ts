/**
 * 跨平台分页一致性检查（#336 B3）。
 *
 * 同一份夹具剧本，在无头 Chromium 里打开打印路由，等 `body[data-print-ready="1"]`
 * （字体全部就位 + 之后的分页测量完成），抓每页的首尾文字与页数，与 golden.json
 * 比对。golden 在 Mac 上生成（--update），CI 在 Linux 上比对——两边页码不同就红。
 *
 * 它守的是字体自托管这件事的**目的**：以前楷体 / 歌词字体走系统字体，Linux 没有、
 * 三个平台三种字宽，行内舞台指示又内嵌在对白块里，换行点不同 → 块高不同 → 分页不同。
 * 结构性守卫（tests/fonts-self-hosted.test.ts）保证「首选面自托管」，这里保证
 * 「结果真的一样」。顺带断言页面实际加载了三个自托管家族——否则就是在拿回退字体比。
 *
 * 用法（先起一个指向测试库的 dev server）：
 *   npx next dev -p 3100 &
 *   BASE_URL=http://localhost:3100 npx tsx scripts/print-consistency/check.ts           # 比对
 *   BASE_URL=http://localhost:3100 npx tsx scripts/print-consistency/check.ts --update  # 重新生成 golden
 *
 * 需要 `npx playwright install chromium`。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true } as Parameters<typeof loadEnv>[0]);

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const GOLDEN_PATH = path.resolve(process.cwd(), process.env.GOLDEN_PATH ?? "scripts/print-consistency/golden.json");
const UPDATE = process.argv.includes("--update");
/** 夹具的排版模式：默认 center；compact 用另一份 golden（GOLDEN_PATH 指过去） */
const FIXTURE_TEXT_LAYOUT: "center" | "compact" = process.env.FIXTURE_TEXT_LAYOUT === "compact" ? "compact" : "center";
/** 夹具的排版模版 id（如 broadway-musical@1）；不设 = 按 textLayoutMode 回退到 legacy */
const FIXTURE_TEMPLATE_ID: string | null = process.env.FIXTURE_TEMPLATE_ID || null;

type Golden = {
  pageLayout: string;
  textLayoutMode: string;
  templateId?: string | null;
  pages: Array<{ first: string; last: string }>;
  fontFamilies: string[];
};

/**
 * 夹具剧本：中文台词 + 行内舞台指示（楷体，内嵌在对白里）+ 拉丁 / 数字 / 标点混排
 * + 歌词行（仿宋）。混排与标点是跨平台字宽差异的来源，必须有；内容量要跨到
 * 三页以上，分页差异才显得出来。文本固定，不用 faker。
 */
function fixtureBlocks(): Array<{ content: string; lyric: boolean; character: 0 | 1 | null; stage?: boolean }> {
  const lines: Array<{ content: string; lyric: boolean; character: 0 | 1 | null; stage?: boolean }> = [];
  const dialogues = [
    "你来了。（放下手里的杯子）我以为你不会来。",
    "路上堵车，从 3 号线换到 10 号线，整整 47 分钟——（看表）现在是 19:05。",
    "这么晚了还有 Coffee? 楼下那家 Blue Bottle 八点关门。",
    "（笑）你什么时候开始在意这些了。A、B、C 三个方案，我都看过了，第二个最像你。",
    "\"最像我\"是什么意思？我从来没有觉得自己像什么。",
    "（沉默片刻，转向窗外）雨停了。明天彩排改到下午 2:30，Stage Manager 刚发的通知。",
    "我知道。Q.12 到 Q.15 全部重排，灯光组说 DMX 地址冲突，要到明早才能解决。",
    "那今晚就别想了。（走近）你脸色很差，Really.",
    "没事，只是……（欲言又止）算了。你先回去吧，我把第 3 场的台本再过一遍。",
    "一起过。两个人快些——而且你一个人会把「过一遍」变成「改一遍」。",
  ];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < dialogues.length; j++) {
      lines.push({ content: `${dialogues[j]}${i > 0 ? `（第 ${i + 1} 遍）` : ""}`, lyric: false, character: (j % 2) as 0 | 1 });
      if (j === 4) lines.push({ content: "（两人对视。远处传来 Piano 的声音，断断续续，像是有人在练同一小节。）", lyric: false, character: null, stage: true });
      if (j === 7) {
        lines.push({ content: "夜色里没有人回头，\n路灯把影子拉成一句没说完的话。", lyric: true, character: 0 });
        lines.push({ content: "Ah——我数着 1、2、3、4 等你开口，\n你却只是把杯子放回原处。", lyric: true, character: 1 });
      }
    }
  }
  return lines;
}

async function seedFixture(): Promise<{ prodId: string; cookie: string; pageLayout: string; textLayoutMode: string; templateId: string | null }> {
  const { getPool } = await import("../../lib/pg");
  const { createProduction, getActiveVersionId, applyPatchToDB, flushToDBVersioned, loadProduction, saveScriptConfig } = await import("../../lib/db");
  const { DEFAULT_SCRIPT_CONFIG } = await import("../../lib/script-types");
  const { createSession, SESSION_COOKIE } = await import("../../lib/session");
  const { randomUUID: uuid } = await import("node:crypto");

  const pool = getPool();
  const owner = (await pool.query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
  const prodId = `tpc${Date.now().toString(36)}`;
  await createProduction(prodId, "分页一致性夹具", owner, "musical");
  const versionId = (await getActiveVersionId(prodId))!;

  const charIds = [uuid(), uuid()];
  await flushToDBVersioned(prodId, versionId, {
    upsertBlocks: [], deleteSnapshotIds: [],
    upsertChars: [
      { id: charIds[0], name: "林晚", isAggregate: false, sortOrder: 1 },
      { id: charIds[1], name: "Daniel", isAggregate: false, sortOrder: 2 },
    ],
    deleteCharIds: [], upsertScenes: [], deleteSceneIds: [],
  });

  const sceneId = randomUUID();
  const insert = (block: Record<string, unknown>, afterId: string | null) => applyPatchToDB(prodId, versionId, {
    clientSeq: 1, blockOps: [{ op: "insert", block: block as never, afterId }], charOps: [], sceneOps: [],
  });
  await insert({
    id: sceneId, type: "chapter_marker", content: "", characterIds: [], characterAnnotations: {},
    lyric: false, sceneId: null, rehearsalMark: null, markerMeta: { number: "1", name: "雨停之后" },
  }, null);
  let afterId: string | null = sceneId;
  for (const line of fixtureBlocks()) {
    const id = randomUUID();
    await insert({
      id, type: line.stage ? "stage" : "dialogue", content: line.content,
      characterIds: line.character === null ? [] : [charIds[line.character]],
      characterAnnotations: {}, lyric: line.lyric, sceneId: null, rehearsalMark: null,
    }, afterId);
    afterId = id;
  }
  if (FIXTURE_TEXT_LAYOUT === "compact" || FIXTURE_TEMPLATE_ID) {
    await saveScriptConfig(prodId, versionId, { ...DEFAULT_SCRIPT_CONFIG, textLayoutMode: FIXTURE_TEXT_LAYOUT, templateId: FIXTURE_TEMPLATE_ID });
  }
  const loaded = (await loadProduction(prodId, versionId))!;
  const cookie = `${SESSION_COOKIE}=${createSession({ userId: owner, name: "夹具", avatarUrl: null, isAdmin: false })}`;
  return { prodId, cookie, pageLayout: loaded.state.config.pageLayout, textLayoutMode: loaded.state.config.textLayoutMode, templateId: loaded.state.config.templateId };
}

async function cleanupFixture(prodId: string): Promise<void> {
  const { getPool } = await import("../../lib/pg");
  const pool = getPool();
  await pool.query("DELETE FROM character_version WHERE character_id IN (SELECT id FROM character WHERE production_id = $1)", [prodId]).catch(() => {});
  await pool.query("DELETE FROM scene_version WHERE scene_id IN (SELECT id FROM scene WHERE production_id = $1)", [prodId]).catch(() => {});
  await pool.query("DELETE FROM production WHERE id = $1", [prodId]).catch(() => {});
}

async function measure(prodId: string, cookie: string): Promise<Pick<Golden, "pages" | "fontFamilies">> {
  const { chromium } = await import("playwright");
  // 本机 VPN 的系统代理会把 localhost 也吞掉（curl 得 000 的那个坑），无头浏览器直连
  const browser = await chromium.launch({ args: ["--no-proxy-server"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
    const url = new URL(BASE_URL);
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, domain: url.hostname, path: "/" }]);
    const page = await context.newPage();
    // tsx（esbuild keepNames）会给 evaluate 回调里的具名函数注入 __name 助手，浏览器里没有它
    await page.addInitScript("globalThis.__name = globalThis.__name || ((fn) => fn);");
    // 超时时把浏览器侧的报错吐出来——否则只看到「等不到就绪属性」，不知道页面为什么没就绪
    const browserLog: string[] = [];
    page.on("console", (msg) => { if (msg.type() === "error" || msg.type() === "warning") browserLog.push(`[${msg.type()}] ${msg.text()}`); });
    page.on("pageerror", (err) => browserLog.push(`[pageerror] ${err.message}`));
    page.on("requestfailed", (req) => browserLog.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ""}`));
    await page.goto(`${BASE_URL}/production/${prodId}/script/print`, { waitUntil: "domcontentloaded" });
    // dev server 首次编译打印路由可能要几十秒；冷的 CI runner 上撞到过 180s 不够（#395 第一轮）
    try {
      await page.waitForSelector('body[data-print-ready="1"]', { timeout: 300_000 });
    } catch (err) {
      const state = await page.evaluate(() => ({
        printReady: document.body.dataset.printReady ?? null,
        pages: document.querySelectorAll(".print-page").length,
        fontsStatus: document.fonts.status,
        title: document.title,
        bodyText: document.body.innerText.slice(0, 300),
      })).catch(() => null);
      console.error("页面未就绪。状态：", JSON.stringify(state), "\n浏览器日志：\n" + browserLog.slice(-30).join("\n"));
      throw err;
    }
    // 可选：把第一张内容页截图存下来（看排版长什么样，评审用）
    if (process.env.SCREENSHOT_PATH) {
      const index = process.env.SCREENSHOT_PAGE ? Number(process.env.SCREENSHOT_PAGE) : 0;
      const target = (await page.$$(".print-page"))[index];
      if (target) await target.screenshot({ path: process.env.SCREENSHOT_PATH });
    }
    const pages = await page.$$eval(".print-page", (nodes) => nodes.map((node) => {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      return { first: text.slice(0, 24), last: text.slice(-24) };
    }));
    const fontFamilies = await page.evaluate(() => {
      const loaded = new Set<string>();
      document.fonts.forEach((face) => { if (face.status === "loaded") loaded.add(face.family.replace(/^['"]|['"]$/g, "")); });
      return [...loaded].sort();
    });
    // 失败时的诊断：各家族的 FontFace 状态分布 + 三个面各自的元素数与实际计算出的字体栈
    const diagnostics = await page.evaluate(() => {
      const byFamily: Record<string, Record<string, number>> = {};
      document.fonts.forEach((face) => {
        const family = face.family.replace(/^['"]|['"]$/g, "");
        byFamily[family] ??= {};
        byFamily[family][face.status] = (byFamily[family][face.status] ?? 0) + 1;
      });
      const errors: string[] = [];
      document.fonts.forEach((face) => {
        if (face.status === "error") errors.push(`${face.family} ${face.weight} ${(face as FontFace & { src?: string }).src ?? ""}`);
      });
      const probe = (selector: string) => {
        const nodes = document.querySelectorAll<HTMLElement>(selector);
        const first = nodes[0];
        return { count: nodes.length, fontFamily: first ? getComputedStyle(first).fontFamily : null, sample: first?.textContent?.slice(0, 20) ?? null };
      };
      // 渲染器给每个槽标了 data-face（模版引擎起样式是内联的，不再有 .font-* 类）
      return { byFamily, errors, script: probe('[data-face="script"]'), stage: probe('[data-face="stage"]'), lyric: probe('[data-face="lyric"]'), stageInline: probe(".stage-inline, [data-stage-inline]") };
    });
    if (process.env.PRINT_DIAG || !["SourceHanSerif", "LXGWWenKai", "ZhuqueFangsong"].every((f) => fontFamilies.includes(f))) {
      console.log("诊断：", JSON.stringify(diagnostics, null, 2));
    }
    return { pages, fontFamilies };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const fixture = await seedFixture();
  try {
    const result = await measure(fixture.prodId, fixture.cookie);
    const current: Golden = { pageLayout: fixture.pageLayout, textLayoutMode: fixture.textLayoutMode, templateId: fixture.templateId, ...result };

    const required = ["SourceHanSerif", "LXGWWenKai", "ZhuqueFangsong"];
    const missing = required.filter((f) => !current.fontFamilies.includes(f));
    if (missing.length > 0) {
      throw new Error(`页面没有加载自托管字体 ${missing.join(", ")}——比对的是回退字体的分页，没有意义。已加载：${current.fontFamilies.join(", ")}`);
    }
    if (current.pages.length < 3) {
      throw new Error(`夹具只排出 ${current.pages.length} 页，分页差异显不出来；加长夹具。`);
    }

    if (UPDATE || !existsSync(GOLDEN_PATH)) {
      writeFileSync(GOLDEN_PATH, JSON.stringify(current, null, 2) + "\n");
      console.log(`golden 已写入 ${path.relative(process.cwd(), GOLDEN_PATH)}：${current.pages.length} 页（${process.platform}）`);
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
    const diffs: string[] = [];
    if (golden.pageLayout !== current.pageLayout || golden.textLayoutMode !== current.textLayoutMode || (golden.templateId ?? null) !== (current.templateId ?? null)) {
      diffs.push(`版式不同：golden ${golden.pageLayout}/${golden.textLayoutMode}/${golden.templateId ?? "-"}，当前 ${current.pageLayout}/${current.textLayoutMode}/${current.templateId ?? "-"}`);
    }
    if (golden.pages.length !== current.pages.length) {
      diffs.push(`页数不同：golden ${golden.pages.length}，当前 ${current.pages.length}`);
    }
    const n = Math.min(golden.pages.length, current.pages.length);
    for (let i = 0; i < n; i++) {
      if (golden.pages[i].first !== current.pages[i].first || golden.pages[i].last !== current.pages[i].last) {
        diffs.push(`第 ${i + 1} 页内容边界不同：\n    golden  ${golden.pages[i].first} … ${golden.pages[i].last}\n    current ${current.pages[i].first} … ${current.pages[i].last}`);
      }
    }
    if (diffs.length > 0) {
      console.error(`分页与 golden 不一致（${process.platform}）：\n  ${diffs.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`分页与 golden 一致：${current.pages.length} 页，字体 ${current.fontFamilies.join(", ")}（${process.platform}）`);
  } finally {
    await cleanupFixture(fixture.prodId);
    const { getPool } = await import("../../lib/pg");
    await getPool().end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
