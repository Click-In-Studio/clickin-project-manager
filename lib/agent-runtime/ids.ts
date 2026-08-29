// 自建运行时各表的 short id（仓库 id 规约：新表 TEXT PK + 前缀 + 时间 + 随机尾，
// 与 lib/db.ts 的 ver_/sn_/blk_ 同款；不用 UUID——这些 id 会出现在 URL 与 SSE 帧里）。

import { randomBytes } from "node:crypto";

function shortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export const newSessionId = () => shortId("as");
export const newRunId = () => shortId("ar");
export const newApprovalId = () => shortId("ap");
export const newQuestionId = () => shortId("aq");
