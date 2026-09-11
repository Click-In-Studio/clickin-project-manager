// #47 docx 解析器真文件冒烟（本地手跑：npx tsx scripts/smoke-docx.ts <file.docx>）。
// 真实剧本含用户内容不入库，冒烟不进 CI——单测用合成 fixture（tests/script/doc-extract.test.ts）。
import fs from "node:fs";
import { bufferByteSource } from "@/lib/asset/byte-source";
import { parseDocx, type DocxParagraph } from "@/lib/doc-extract/docx";

const file = process.argv[2];
if (!file) { console.error("用法：npx tsx scripts/smoke-docx.ts <file.docx> [from] [to]"); process.exit(1); }
const from = Number(process.argv[3] ?? 0);
const to = Number(process.argv[4] ?? from + 30);

async function main() {
  const t0 = Date.now();
  const doc = await parseDocx(bufferByteSource(fs.readFileSync(file)));
  console.log(`解析耗时 ${Date.now() - t0}ms；`, JSON.stringify(doc.stats));

  const hist = new Map<string, number>();
  for (const it of doc.items) {
    if (it.kind !== "p") continue;
    const key = `${it.align ?? "-"}/${it.indent != null ? Math.round(it.indent / 120) * 120 : 0}`;
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  console.log("对齐/缩进桶：", [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));

  for (let i = from; i <= Math.min(to, doc.items.length - 1); i++) {
    const it = doc.items[i];
    if (it.kind === "table") { console.log(`[¶${i} 表格 ${it.rows.length}×${it.rows[0]?.length ?? 0}]`); continue; }
    const p = it as DocxParagraph;
    const tags = [p.style, p.align, p.indent != null ? `ind=${p.indent}` : null, p.flags?.join(""), p.font, p.sz != null ? `sz=${p.sz}` : null]
      .filter(Boolean).join(" ");
    console.log(`[¶${i}${tags ? " " + tags : ""}] ${p.text.slice(0, 60)}`);
  }
}
void main();
