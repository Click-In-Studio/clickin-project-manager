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

/** 惰性求值 + 生产环境快速失败：AGENT_MEMORY_PATH 未设时默认路径相对
 * cwd（= release 目录），生产环境下等于每次部署丢记忆——静默降级不可
 * 接受，首次**使用**时抛错（不在模块顶层抛：next build 也带
 * NODE_ENV=production，模块级抛会炸构建）。 */
export function memoryRoot(): string {
  if (process.env.AGENT_MEMORY_PATH) return path.resolve(process.env.AGENT_MEMORY_PATH);
  if (process.env.NODE_ENV === "production") {
    throw new Error("AGENT_MEMORY_PATH 未设置——生产环境必须指向 shared/ 持久目录（默认相对 cwd 会随 release 轮换丢数据）");
  }
  return path.join(process.cwd(), "data", "agent-memory");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userDir(userId: string): string {
  // userId 进路径前强校验（来源是插件解析的 sessionKey，理应干净，但
  // 路径拼接的输入永远不豁免校验）
  if (!UUID_RE.test(userId)) throw new Error(`invalid userId for memory path: ${userId}`);
  return path.join(memoryRoot(), userId.toLowerCase());
}

/** 原子写：临时文件 + rename——半截写入的 MEMORY.md/state.json 会被
 * 读回并注入每一轮 prompt，崩溃安全必须与偏移幂等设计同级。 */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
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
  atomicWrite(path.join(dir, "MEMORY.md"), content);
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
  atomicWrite(path.join(dir, "state.json"), JSON.stringify(state));
}

/** 读取自上次蒸馏以来的新 episodic 条目（按字节偏移增量消费）。
 * 超出 maxChars 的批次会截断：nextOffset 精确指向**最后一条已消费行**
 * 之后（按 UTF-8 字节数累计，不是字符数），未消费的行留待下次——
 * 早期版本无条件返回文件尾偏移，截断批次的剩余数据被永久跳过
 * （review #205 抓出的 critical）。 */
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
  let consumedBytes = 0;
  let totalChars = 0;
  for (const line of buf.toString("utf-8").split("\n")) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 = 换行符
    if (!line.trim()) {
      consumedBytes += lineBytes;
      continue;
    }
    let rec: RunRecord;
    try {
      rec = JSON.parse(line) as RunRecord;
    } catch {
      consumedBytes += lineBytes; // 坏行消费掉，不阻塞后续
      continue;
    }
    // 容量判定在消费**之前**：超限的行不计入本批、不推进偏移——
    // 但至少消费一条，保证单条超大行也能推进（否则死循环）
    if (entries.length > 0 && totalChars + line.length > maxChars) break;
    entries.push(rec);
    totalChars += line.length;
    consumedBytes += lineBytes;
  }
  // 末行可能无尾随换行，+1 会多算一字节——夹到文件大小
  return { entries, nextOffset: Math.min(from + consumedBytes, size) };
}

export function commitDistill(userId: string, nextOffset: number): void {
  writeState(userId, { runsOffset: nextOffset, lastDistilledAt: new Date().toISOString() });
}

/** 有 episodic 数据的全部用户目录。 */
export function listUserIds(): string[] {
  try {
    return fs
      .readdirSync(memoryRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && UUID_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
