import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const S = process.argv[2];
const sid = readFileSync(`${S}/sid3.txt`, "utf8").trim();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
await ctx.addCookies([{ name: "sid", value: sid, domain: "127.0.0.1", path: "/" }]);
const P = "demo-misty-harbor";
const page = await ctx.newPage();
const txt = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ");
for (const p of process.argv.slice(3)) {
  try {
    await page.goto(`http://127.0.0.1:3000/production/${P}/${p}`, { waitUntil: "domcontentloaded", timeout: 90000 }); await page.waitForTimeout(2500);
    const act = page.getByRole("button", { name: /一键激活/ });
    if (await act.count()) { await act.first().scrollIntoViewIfNeeded(); await act.first().click(); await page.waitForTimeout(1500); await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForTimeout(2000); }
    await page.screenshot({ path: `${S}/explore4/${p.replace(/\//g, "-")}.png` });
    const t = await txt(); const i = t.indexOf("危险操作 | 归档"); console.log(`\n## ${p}: ${t.slice(i > 0 ? i + 12 : 0, (i > 0 ? i + 12 : 0) + 1400)}`);
  } catch (e) { console.log(`\n## ${p}: ERR ${e.message.split("\n")[0]}`); }
}
await browser.close();
