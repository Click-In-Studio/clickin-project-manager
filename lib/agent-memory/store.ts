// Agent 记忆存储（后端所有权）。
//
// 记忆文件从 gateway 主机的插件目录迁移到后端：插件（openclaw 用户）写不
// 进后端目录、后端（部署用户）写不进 openclaw 的 home——所有权必须单边。
// 归后端的理由：蒸馏管线要写 MEMORY.md、注入预算要集中管理、未来控制面
// 记忆服务就是这个形态。插件退化为纯传输层（HTTP 上报/取件，见 MCP 端点）。
//
// 目录结构：
//   <root>/<userId>/runs.jsonl    个人 episodic（agent_end 上报追加）
//   <root>/<userId>/MEMORY.md     个人长期精粹（蒸馏产物）
//   <root>/<userId>/state.json    蒸馏进度（runs.jsonl 已消费字节偏移）
//
// ⚠️ 服务器必须显式设置 AGENT_MEMORY_PATH 指向 shared/（默认相对 cwd，
// release 轮换会丢数据）。

import fs from "node:fs";
import path from "node:path";

export const MEMORY_ROOT = process.env.AGENT_MEMORY_PATH
  ? path.resolve(process.env.AGENT_MEMORY_PATH)
  : path.join(process.cwd(), "data", "agent-memory");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userDir(userId: string): string {
  // userId 进路径前强校验（来源是插件解析的 sessionKey，理应干净，但
  // 路径拼接的输入永远不豁免校验）
  if (!UUID_RE.test(userId)) throw new Error(`invalid userId for memory path: ${userId}`);
  return path.join(MEMORY_ROOT, userId.toLowerCase());
}

export type RunRecord = {
  ts: string;
  sessionKey?: string;
  runId?: string | null;
  productionId?: string | null;
  success?: boolean;
  error?: string | null;
  durationMs?: number | null;
  lastUser?: string | null;
  lastAssistant?: string | null;
};

export function appendRunRecord(userId: string, record: RunRecord): void {
  const dir = userDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
}

export function readMemory(userId: string, maxChars: number): string | null {
  try {
    const file = path.join(userDir(userId), "MEMORY.md");
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, "utf-8").trim();
    if (!content) return null;
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n…（记忆摘要已截断）` : content;
  } catch {
    return null;
  }
}

export function writeMemory(userId: string, content: string): void {
  const dir = userDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "MEMORY.md"), content, "utf-8");
}

const TAIL_READ_BYTES = 256 * 1024;

/** runs.jsonl 尾部窗口读取（近期 episodic 注入用）。 */
export function readRecentRuns(
  userId: string,
  opts: { days: number; maxEntries: number; maxChars: number; excludeSessionKey?: string },
): string | null {
  try {
    const file = path.join(userDir(userId), "runs.jsonl");
    if (!fs.existsSync(file)) return null;
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const readFrom = Math.max(0, size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(size - readFrom);
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);
    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    if (readFrom > 0) lines.shift(); // 掐头：第一行可能是被截断的半条

    const cutoff = Date.now() - opts.days * 24 * 60 * 60 * 1000;
    const picked: string[] = [];
    for (let i = lines.length - 1; i >= 0 && picked.length < opts.maxEntries; i--) {
      let rec: RunRecord;
      try {
        rec = JSON.parse(lines[i]) as RunRecord;
      } catch {
        continue;
      }
      if (!rec.ts || Date.parse(rec.ts) < cutoff) break; // 尾部按时间有序，出窗即停
      if (opts.excludeSessionKey && rec.sessionKey === opts.excludeSessionKey) continue;
      const user = (rec.lastUser ?? "").slice(0, 200);
      const assistant = (rec.lastAssistant ?? "").slice(0, 200);
      if (!user && !assistant) continue;
      picked.push(`- [${rec.ts.slice(0, 16).replace("T", " ")}] 用户：${user || "（无）"} ｜ 助手：${assistant || "（无）"}`);
    }
    if (picked.length === 0) return null;
    picked.reverse();
    const text = picked.join("\n");
    return text.length > opts.maxChars ? `${text.slice(0, opts.maxChars)}\n…（近期对话已截断）` : text;
  } catch {
    return null;
  }
}

// ─── 蒸馏支持 ────────────────────────────────────────────────────────────────

type DistillState = { runsOffset: number; lastDistilledAt?: string };

function readState(userId: string): DistillState {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDir(userId), "state.json"), "utf-8")) as DistillState;
  } catch {
    return { runsOffset: 0 };
  }
}

function writeState(userId: string, state: DistillState): void {
  const dir = userDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state), "utf-8");
}

/** 读取自上次蒸馏以来的新 episodic 条目（按字节偏移增量消费）。 */
export function readRunsSinceLastDistill(userId: string, maxChars: number): { entries: RunRecord[]; nextOffset: number } {
  const file = path.join(userDir(userId), "runs.jsonl");
  if (!fs.existsSync(file)) return { entries: [], nextOffset: 0 };
  const size = fs.statSync(file).size;
  const state = readState(userId);
  // 文件被清空/重建（偏移越界）→ 从头
  const from = state.runsOffset > size ? 0 : state.runsOffset;
  if (from >= size) return { entries: [], nextOffset: from };

  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);

  const entries: RunRecord[] = [];
  let total = 0;
  for (const line of buf.toString("utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as RunRecord;
      total += line.length;
      entries.push(rec);
      if (total > maxChars) break; // 单次蒸馏输入上限，剩余下次消费
    } catch {
      continue;
    }
  }
  return { entries, nextOffset: size };
}

export function commitDistill(userId: string, nextOffset: number): void {
  writeState(userId, { runsOffset: nextOffset, lastDistilledAt: new Date().toISOString() });
}

/** 有 episodic 数据的全部用户目录。 */
export function listUserIds(): string[] {
  try {
    return fs
      .readdirSync(MEMORY_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && UUID_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
