// 席位余量的展示口径（#313）——纯函数、无 db 依赖，可进客户端包。
// 数据本身来自服务端 getSeatUsage（lib/account/plan.ts），这里只管怎么说。

export type SeatInfo = { used: number; limit: number };

export type SeatTone = "ok" | "warn" | "full";

/** ≥80% 提醒、满员告警；limit 很小（free 10）时 8/10 就是黄。 */
export function seatTone({ used, limit }: SeatInfo): SeatTone {
  if (used >= limit) return "full";
  if (used >= Math.ceil(limit * 0.8)) return "warn";
  return "ok";
}

export function seatsRemaining({ used, limit }: SeatInfo): number {
  return Math.max(0, limit - used);
}

export const SEAT_TONE_COLOR: Record<SeatTone, string> = {
  ok: "var(--muted)",
  warn: "var(--warn)",
  full: "var(--danger)",
};

/** 发起侧的满员/将满提示；ok 时返回 null（不打扰）。 */
export function seatHint(s: SeatInfo): string | null {
  const tone = seatTone(s);
  if (tone === "full") return `席位已满（${s.used} / ${s.limit}），确认离组已停用成员或升级项目档位后可继续邀请`;
  if (tone === "warn") return `席位余量 ${seatsRemaining(s)}（${s.used} / ${s.limit}）`;
  return null;
}

/** 批量发送超过余量时的提示：不拦，只说清楚后果。 */
export function seatOverflowHint(s: SeatInfo, count: number): string | null {
  const left = seatsRemaining(s);
  if (count <= left) return null;
  return `席位余量 ${left}，本次将发出 ${count} 份邀请：先接受的先进，超出的 ${count - left} 位接受时会被拒`;
}
