// #47 pdf 解析器真文件冒烟（本地手跑：npx tsx scripts/smoke-pdf.ts <file.pdf> [页...]）。
// 真实剧本含用户内容不入库，冒烟不进 CI——单测用合成 fixture（tests/script/doc-extract.test.ts）。
import fs from "node:fs";
import { parsePdf } from "@/lib/doc-extract/pdf";

const [file, ...pageArgs] = process.argv.slice(2);
if (!file) { console.error("用法：npx tsx scripts/smoke-pdf.ts <file.pdf> [页序...]"); process.exit(1); }

async function main() {
  const t0 = Date.now();
  const doc = await parsePdf(fs.readFileSync(file));
  console.log(`解析耗时 ${Date.now() - t0}ms；`, JSON.stringify(doc.stats));
  console.log("字体图例：", JSON.stringify(doc.fontLegend), "主字体：", doc.majorityFont);
  if (doc.boilerplate.length) console.log("跨页重复行：", doc.boilerplate.slice(0, 4));

  for (const a of pageArgs.length ? pageArgs.map(Number) : [1]) {
    const p = doc.pages[a - 1];
    if (!p) { console.log(`p${a} 不存在`); continue; }
    console.log(`\n── p${p.n} ${p.vertical ? "竖排" : "横排"} status=${p.status} lines=${p.lines.length} ──`);
    for (let i = 0; i < Math.min(p.lines.length, 30); i++) {
      const ln = p.lines[i];
      const tags = [`x=${ln.x}`, p.vertical ? `y=${ln.y}` : null, ln.font, ln.boilerplate ? "≡" : null].filter(Boolean).join(" ");
      console.log(`[p${p.n}.${i} ${tags}] ${ln.text.slice(0, 66)}`);
    }
  }
}
void main();
