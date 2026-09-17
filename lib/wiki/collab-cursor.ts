/**
 * wiki 协作光标（#515）：客户端/服务端共用的纯逻辑，不碰 pg。
 *
 * 光标是纯位置量 {blockIndex, offset}，没有稳定锚点：远端拿新坐标去套自己手里的
 * 旧文档就会钳到段尾、跳到无关段落。所以本端有未保存改动时光标**不走独立通道**，
 * 而是搭保存那一笔的 update 帧——它和提交的正文是同一份快照，"内容到达 = 光标到达"。
 * 干净（纯浏览、点来点去）时才走 400ms 节流的 presence POST。
 */

export type WikiCursor = { blockIndex: number; offset: number };

function sameCursor(a: WikiCursor | null, b: WikiCursor | null): boolean {
  return a === b || (a != null && b != null && a.blockIndex === b.blockIndex && a.offset === b.offset);
}

export type CursorRelay = {
  /** 编辑器 selection 变化 */
  report(cursor: WikiCursor): void;
  /** 保存路径起点：取当前光标（与正文快照同一时刻），独立通道的计时器一并撤掉。
   *  这一步不算送出——保存可能提前返回（空标题/无变化），那就由 afterSave 补发 */
  takeForSave(): WikiCursor | null;
  /** PATCH 已带上这个光标 */
  markSent(cursor: WikiCursor | null): void;
  /** 保存路径结束（不论是否真的发了 PATCH）：干净且还有没送出的位置 → 走独立通道 */
  afterSave(): void;
  dispose(): void;
};

export function createCursorRelay(opts: {
  isDirty: () => boolean;
  post: (cursor: WikiCursor) => void;
  throttleMs: number;
}): CursorRelay {
  let pending: WikiCursor | null = null;
  let lastSent: WikiCursor | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // trailing 节流：leading 会发陈旧位置。到点时再查一次 dirty——400ms 里用户可能
  // 已经开始打字，那就让保存带走它
  const arm = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!pending || sameCursor(pending, lastSent) || opts.isDirty()) return;
      lastSent = pending;
      opts.post(pending);
    }, opts.throttleMs);
  };

  return {
    report(cursor) {
      pending = cursor;
      if (!opts.isDirty()) arm();
    },
    takeForSave() {
      if (timer) { clearTimeout(timer); timer = null; }
      return pending;
    },
    markSent(cursor) { lastSent = cursor; },
    afterSave() {
      if (!opts.isDirty() && pending && !sameCursor(pending, lastSent)) arm();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** update 帧带来的发起端光标落进在场表（发起端不在表里=它的 SSE 已断，不造幽灵） */
export function applyPeerCursor<P extends { clientId: string; blockIndex: number | null; offset: number | null }>(
  peers: P[],
  byClientId: string | null,
  cursor: WikiCursor | null | undefined,
): P[] {
  if (!byClientId || cursor === undefined) return peers;
  let changed = false;
  const next = peers.map((p) => {
    if (p.clientId !== byClientId) return p;
    const blockIndex = cursor?.blockIndex ?? null;
    const offset = cursor?.offset ?? null;
    if (p.blockIndex === blockIndex && p.offset === offset) return p;
    changed = true;
    return { ...p, blockIndex, offset };
  });
  return changed ? next : peers;
}
