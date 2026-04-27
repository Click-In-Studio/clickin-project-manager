import { getAppAccessToken } from "./feishu-auth";

const BASE = "https://open.feishu.cn/open-apis";

export async function sendBotDm(openId: string, text: string): Promise<void> {
  const token = await getAppAccessToken();
  const res = await fetch(`${BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });
  const raw = await res.text();
  let data: { code: number; msg: string };
  try { data = JSON.parse(raw); } catch { throw new Error(`飞书机器人返回非 JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`); }
  if (data.code !== 0) {
    console.error(`[feishu-bot] DM to ${openId} failed: code=${data.code} msg=${data.msg}`);
    throw new Error(`飞书机器人推送失败 (${data.code}): ${data.msg}`);
  }
}

// ─── Interactive card dispatch ────────────────────────────────────────────────

export async function sendCard(openId: string, card: object): Promise<void> {
  const token = await getAppAccessToken();
  const res = await fetch(`${BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });
  const raw = await res.text();
  let data: { code: number; msg: string };
  try { data = JSON.parse(raw); } catch { throw new Error(`Feishu non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`); }
  if (data.code !== 0) throw new Error(`Feishu card error ${data.code}: ${data.msg}`);
}

// ─── Timezone helpers (display in CST = UTC+8) ────────────────────────────────

function cst(iso: string): Date {
  return new Date(new Date(iso).getTime() + 8 * 3_600_000);
}
export function fmtDate(iso: string): string {
  const d = cst(iso);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
export function fmtTime(iso: string): string {
  const d = cst(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// ─── Card shape ───────────────────────────────────────────────────────────────

function makeCard(title: string, template: string, bodyMd: string, url: string, btnLabel: string): object {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: bodyMd } },
      { tag: "hr" },
      { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: btnLabel }, url, type: "primary" }] },
    ],
  };
}

// ─── Weekly call ──────────────────────────────────────────────────────────────

export type WeeklyCallEntry = {
  callAt: string;
  eventId: string;
  eventTitle: string;
  eventLocation: string;
  callNotes: string;
  productionId: string;
  scheduleItems: { title: string; startTime: string | null }[];
  myTechReqs: { title: string }[];
};

export function buildWeeklyCallCard(entries: WeeklyCallEntry[], pageUrl: string): object {
  const byEvent = new Map<string, WeeklyCallEntry[]>();
  for (const e of entries) {
    if (!byEvent.has(e.eventId)) byEvent.set(e.eventId, []);
    byEvent.get(e.eventId)!.push(e);
  }

  const lines: string[] = [];
  for (const [, evEntries] of byEvent) {
    const first = evEntries[0];
    const calls = evEntries.map(e => `**${fmtTime(e.callAt)}**`).join(" / ");
    lines.push(`**${first.eventTitle}**${first.eventLocation ? `  📍 ${first.eventLocation}` : ""}`);
    lines.push(`Call: ${calls}`);
    if (first.scheduleItems.length) {
      const sched = first.scheduleItems
        .map(s => (s.startTime ? `${fmtTime(s.startTime)} ${s.title}` : s.title))
        .join(" → ");
      lines.push(`日程: ${sched}`);
    }
    if (first.myTechReqs.length) {
      lines.push(`待处理需求: ${first.myTechReqs.map(r => r.title).join("、")}`);
    }
    lines.push("");
  }

  const weekStart = fmtDate(entries[0].callAt);
  return makeCard(
    `本周 Call 安排（${weekStart}起）`, "blue",
    lines.join("\n").trimEnd(),
    pageUrl,
    "查看完整日程",
  );
}

// ─── Daily call ───────────────────────────────────────────────────────────────

export type DailyCallScheduleItem = {
  title: string;
  startTime: string | null;
  participants: string[];
};

export function buildDailyCallCard(
  eventTitle: string,
  eventLocation: string,
  eventStartTime: string,
  userCallAt: string,
  userCallNotes: string,
  scheduleItems: DailyCallScheduleItem[],
  allCalls: { name: string; callAt: string; callNotes: string }[],
  url: string,
): object {
  const lines: string[] = [
    `📍 **${eventLocation || eventTitle}** — ${fmtDate(eventStartTime)}`,
    `你的 Call: **${fmtTime(userCallAt)}**${userCallNotes ? `（${userCallNotes}）` : ""}`,
  ];

  if (scheduleItems.length) {
    lines.push("", "**日程**");
    for (const item of scheduleItems) {
      const t = item.startTime ? fmtTime(item.startTime) : "--:--";
      const people = item.participants.length
        ? `（${item.participants.slice(0, 4).join("、")}${item.participants.length > 4 ? " 等" : ""}）`
        : "";
      lines.push(`${t}  ${item.title}${people}`);
    }
  }

  if (allCalls.length > 1) {
    lines.push("", "**全组 Call**");
    for (const c of allCalls) {
      lines.push(`${fmtTime(c.callAt)}  ${c.name}${c.callNotes ? `（${c.callNotes}）` : ""}`);
    }
  }

  return makeCard(
    `明日 Call Sheet — ${eventTitle}`, "wathet",
    lines.join("\n"),
    url, "查看 Call Sheet",
  );
}

// ─── Report ───────────────────────────────────────────────────────────────────

export function buildReportCard(
  reportTitle: string,
  eventTitle: string,
  body: string,
  notes: { deptName: string; content: string }[],
  publishedAt: string,
  url: string,
): object {
  const preview = body.length > 120 ? body.slice(0, 120).trimEnd() + "…" : body;
  const lines = [
    `📋 **${eventTitle}** — ${reportTitle}`,
    ...(preview ? ["", `> ${preview.replace(/\n/g, "\n> ")}`] : []),
  ];
  for (const note of notes) {
    const snippet = note.content.length > 100 ? note.content.slice(0, 100).trimEnd() + "…" : note.content;
    lines.push("", `**${note.deptName}**`, snippet);
  }
  lines.push("", `_发布于 ${fmtDate(publishedAt)} ${fmtTime(publishedAt)}_`);
  return makeCard(`新报告 — ${reportTitle}`, "green", lines.join("\n"), url, "查看报告");
}
