/**
 * revoke-streams.ts — 撤销写点调用的断流入口（#469）。
 *
 * 本进程注册表直接踢 + outbox 出站一条给别的进程（agent-runner 收 wiki 分享时，被收权
 * 者的连接在 next 进程）。出站失败只记日志：断流是权限收敛的加速器，不能拖垮撤销写库。
 *
 * 调用时机：**事务 COMMIT 之后**。踢早了，客户端重连过门时读到的还是旧行，流原样建回。
 * 所以挂在路由层 / 工具层的 lib 调用返回之后，而不是 lib 事务内部。
 *
 * userId 省略 = 踢整个 production（部门权限、角色权限、文档结构面分享这类影响多人的写点）。
 */

import { kickUserStreams } from "@/lib/sse-kick";
import { publishKickRemote } from "@/lib/wiki/collab";

export function kickRevokedStreams(productionId: string, userId?: string): void {
  kickUserStreams(productionId, userId);
  void publishKickRemote(productionId, userId)
    .catch((err) => console.error("[sse-kick] publish failed:", err));
}
