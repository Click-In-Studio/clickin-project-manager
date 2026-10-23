"use client";

import { Fragment, memo, useMemo, useRef, type ComponentProps } from "react";
import WikiMarkdown from "./WikiMarkdown";
import { MarkdownStream, type MarkdownTableModel } from "@/lib/wiki/markdown-stream";

type Context = Pick<ComponentProps<typeof WikiMarkdown>, "productionId" | "versionId" | "wikiRouteBase" | "members">;
const TableRow = memo(function TableRow({ cells, header, align, context }: {
  cells: string[]; header: boolean; align: MarkdownTableModel["align"]; context: Context;
}) {
  const Tag = header ? "th" : "td";
  return <tr>{cells.map((content, i) => <Tag key={i} style={align[i] ? { textAlign: align[i] } : undefined}>
    <WikiMarkdown {...context} content={content} inline fragment />
  </Tag>)}</tr>;
}, (a, b) => a.header === b.header && a.context === b.context && a.align === b.align
  && a.cells.length === b.cells.length && a.cells.every((value, i) => value === b.cells[i]));

export default memo(function StreamingWikiMarkdown({ content, streaming, productionId, versionId, members, wikiRouteBase }: Context & {
  content: string; streaming: boolean;
}) {
  const parser = useRef<MarkdownStream | null>(null);
  if (!parser.current) parser.current = new MarkdownStream();
  const pieces = useMemo(() => parser.current!.update(content), [content]);
  const context = useMemo(() => ({ productionId, versionId, members, wikiRouteBase }), [productionId, versionId, members, wikiRouteBase]);
  return <div className="prose prose-zinc prose-sm max-w-none">{pieces.map((piece, index) => <Fragment key={index}>
    {index > 0 ? "\n" : null}
    {piece.table ? <>
      <div className="wiki-table-scroll"><table>
        <thead><TableRow cells={piece.table.header} header align={piece.table.align} context={context} /></thead>
        <tbody>{piece.table.rows.map((cells, row) => <TableRow key={row} cells={cells} header={false} align={piece.table!.align} context={context} />)}</tbody>
      </table></div>
      {piece.table.after && <>{"\n"}<WikiMarkdown {...context} content={piece.table.after} fragment streaming={streaming} /></>}
    </> : <WikiMarkdown {...context} content={piece.source} fragment streaming={streaming && index === pieces.length - 1} />}
  </Fragment>)}</div>;
});
