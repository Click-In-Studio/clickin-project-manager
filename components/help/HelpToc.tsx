// 页内目录（#531）：h2 / h3 两级，锚点与正文 id 同源（lib/help/manual.extractHeadings）。

import type { ManualHeading } from "@/lib/help/manual";

export default function HelpToc({ headings }: { headings: ManualHeading[] }) {
  if (headings.length === 0) return null;
  return (
    <nav className="help-toc" aria-label="本页目录">
      <div className="help-toc-title">本页内容</div>
      <ul>
        {headings.map((h) => (
          <li key={h.id} className={h.depth === 3 ? "is-sub" : undefined}>
            <a href={`#${h.id}`}>{h.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
