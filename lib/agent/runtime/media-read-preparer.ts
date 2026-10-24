import type { Context, MediaContent, Model } from "../../../vendor/openclaw/packages/llm-core/src/types";
import { estimateRequestBudget } from "./context-budget";
import { mediaIdentity } from "./media-budget";
import { CompactionBudgetError } from "./request-compaction";

/** 每个执行实例独占队列；原件下载可并发，会话整理与本批预算预留必须串行。 */
export function createMediaReadPreparer(input: {
  model: Model;
  signal: AbortSignal;
  buildContext: (pending: MediaContent[]) => Promise<Context>;
  prepareRequest: (context: Context, pending: MediaContent[]) => Promise<Context>;
}) {
  let tail = Promise.resolve();
  const reserved = new Map<string, MediaContent>();
  return {
    // harness 等同批工具全部完成后才准备下一次模型请求，此时 tail 已排空。
    // 工具阶段摘要直接走 budgetedComplete，不会调用此入口；此后以正式 context 为准。
    requestStarted() { reserved.clear(); },
    prepare(media: MediaContent): Promise<boolean> {
      const next = tail.then(async () => {
        input.signal.throwIfAborted();
        const pending = new Map(reserved);
        pending.set(mediaIdentity(media), media);
        const parts = [...pending.values()];
        const context = await input.buildContext(parts);
        // 未消费的同批新原件必须一起容纳，不能把其中几张先压缩成摘要。
        if (!estimateRequestBudget(input.model, { ...context,
          messages: [{ role: "user", timestamp: 0, content: parts }],
        }).fits) return false;
        try {
          const prepared = await input.prepareRequest(context, parts);
          if (!estimateRequestBudget(input.model, prepared).fits) return false;
          reserved.set(mediaIdentity(media), media);
          return true;
        } catch (error) {
          if (error instanceof CompactionBudgetError) return false;
          throw error;
        }
      });
      // 一个读取失败不破坏后续队列；调用者仍收到原始错误。
      tail = next.then(() => {}, () => {});
      return next;
    },
  };
}
