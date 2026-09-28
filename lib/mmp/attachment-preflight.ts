// 会话附件的自动预检边界（#704 给 #734 与 MMP triage.image 留的接点）。
//
// 预检与显式能力必须分开：triage.audio / triage.image 负责给基础模型一份任务无关的
// digest（原子事实、gaps、capabilities_available）；ocr.structured 等能力只有模型看完
// digest 后认为需要时才调用。当前 @mmp/client 尚未发布 triage.image 契约，因此这里
// 只诚实返回 unavailable；协议落地后替换本函数，不改附件表、消息信封或读取工具。

export type AttachmentPreflightOutcome =
  | { status: "ok"; renderedDigest: string }
  | { status: "unavailable"; reason: string };

type PreflightInput = {
  /** 开放字符串；新增模态不改附件协议。 */
  mediaKind: string;
  attachmentId: string;
  fileName: string;
  mimeType: string;
  r2Key: string;
};
type PreflightAdapter = (input: PreflightInput, opts: { signal?: AbortSignal }) => Promise<AttachmentPreflightOutcome>;

// 能力选择在这里显式登记，不能把用户可控 mediaKind 直接拼成任意 MMP task type。
// triage.image / triage.audio 发布后各加一项；将来新增 video 也不改上层附件链路。
const PREFLIGHT_ADAPTERS: Readonly<Record<string, PreflightAdapter>> = {};

export async function preflightAttachment(
  input: PreflightInput,
  opts: { signal?: AbortSignal } = {},
): Promise<AttachmentPreflightOutcome> {
  const adapter = PREFLIGHT_ADAPTERS[input.mediaKind];
  if (adapter) return adapter(input, opts);
  return {
    status: "unavailable",
    reason: `${input.mediaKind} 预检能力尚未接入会话附件；原件仍可用。`,
  };
}
