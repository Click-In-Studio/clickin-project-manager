/**
 * OpenClaw gateway 活体探针——验证 relay 重构（静默→权威查询 / 文本源纪律 /
 * question.* 通道）所依赖的三组协议假设。这类假设读代码测不出来（bug 形态
 * 是"不报错、只是什么都没发生"），只能实测（MindWeave《Agent 流式中继：
 * 静默不等于结束》§4/§6/§7、《OpenClaw ask_user 问题机制调研》§4）。
 *
 * 跑法（在 gateway 所在机器、项目根目录下，需 .env.local 有 token）：
 *   npx tsx scripts/gateway-probe.ts --status [sessionKey]   # 只读：握手 scope + sessions.list 形态
 *   npx tsx scripts/gateway-probe.ts --questions             # 只读：question.list 是否被 scope 放行
 *   npx tsx scripts/gateway-probe.ts --watch <sessionKey> [--for 60]  # 只读：原始事件 tap
 *   npx tsx scripts/gateway-probe.ts --question-roundtrip    # 微副作用：造一个真问题→观察信封→立即取消
 *   npx tsx scripts/gateway-probe.ts --exercise ["<指令>"]   # 有副作用：真实 run（默认 exec sleep 45s；
 *                                                            #   agent 无 exec 时传一条会调它现有工具的指令），
 *                                                            #   验证 run 中 status 与 delta/text 形态，事后删会话
 *
 * 探针用独立随机 uuid 作 userId，会话不会出现在任何真实用户列表里；
 * --exercise 结束后 sessions.delete 清理。
 *
 * 服务器跑法（standalone 构建无 tsx）：本地打包后 scp——
 *   npx esbuild scripts/gateway-probe.ts --bundle --platform=node --format=cjs \
 *     --external:bufferutil --external:utf-8-validate --outfile=/tmp/gateway-probe.cjs
 *   scp /tmp/gateway-probe.cjs click-in:/tmp/ && ssh click-in \
 *     'cd /var/www/production-manager/current && node --env-file=../shared/.env.local /tmp/gateway-probe.cjs --status'
 *
 * 已验证结论（2026-08-21，gateway 2026.7.1-2）：canonical 前缀是 agent:team:；
 * sessions.list 用 raw key 搜索能命中 canonical 行（需后缀容错比较）；run 进行
 * 中 status=running、结束后 done；事件只在 canonical key 频道发布（raw=0）；
 * assistant 事件 delta/text 恒并存、text 为严格累计值、无重发；question.* 协议
 * 与 ask_user 尚不存在（unknown method）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GatewayClient } from "@openclaw/gateway-client";
import { GATEWAY_CLIENT_CAPS, GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "@openclaw/gateway-protocol/client-info";
import * as device from "../lib/agent-gateway/device";
import { GATEWAY_URL } from "../lib/agent-gateway/config";

// 与应用同一套 scope（验证"question.* 无需新增 scope、admin 被短路放行"）
const SCOPES = ["operator.read", "operator.write", "operator.admin", "operator.approvals"];

// ── env：独立脚本不经 Next，自己读 .env.local 补 token ────────────────────
if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
  const envPath = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^(OPENCLAW_GATEWAY_TOKEN|OPENCLAW_GATEWAY_URL|AGENT_GATEWAY_DATA_PATH)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
  console.error("no OPENCLAW_GATEWAY_TOKEN (env or ./.env.local) — 在 gateway 所在机器的项目目录下跑");
  process.exit(1);
}

const ts0 = Date.now();
const t = () => `T+${((Date.now() - ts0) / 1000).toFixed(1)}s`;

interface RawEvent {
  event: string;
  payload?: unknown;
}

function connectProbe(onEvent: (evt: RawEvent) => void): Promise<{
  request: <T>(method: string, params?: unknown) => Promise<T>;
  stop: () => void;
  scopes: unknown;
}> {
  return new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: process.env.OPENCLAW_GATEWAY_URL || GATEWAY_URL,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      role: "operator",
      scopes: SCOPES,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
      clientDisplayName: "Click-In Probe",
      clientVersion: "0.0.1",
      platform: process.platform,
      minProtocol: 4,
      maxProtocol: 4,
      caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
      hostDeps: {
        loadOrCreateDeviceIdentity: device.loadOrCreateDeviceIdentity,
        signDevicePayload: device.signDevicePayload,
        publicKeyRawBase64UrlFromPem: device.publicKeyRawBase64UrlFromPem,
        loadDeviceAuthToken: device.loadDeviceAuthToken,
        storeDeviceAuthToken: device.storeDeviceAuthToken,
        clearDeviceAuthToken: device.clearDeviceAuthToken,
      },
      onEvent,
      onHelloOk: (hello: unknown) => {
        const scopes = (hello as { scopes?: unknown } | undefined)?.scopes;
        resolve({
          request: (method, params) => client.request(method, params, { timeoutMs: 30_000 }),
          stop: () => client.stop(),
          scopes,
        });
      },
      onConnectError: (err: { message?: string }) => reject(new Error(`connect failed: ${err?.message}`)),
      onClose: () => {},
    });
    client.start();
  });
}

// ── 原始 assistant 事件形态统计（§6 的三个判据）─────────────────────────────
function makeShapeStats() {
  const stats = {
    both: 0, // delta 与 text 同时存在
    deltaOnly: 0, // 只有 delta（裸增量——relay 忽略保护针对的形态）
    textOnly: 0, // 只有 text
    replaceTrue: 0,
    textIsCumulative: true, // text 是否单调不减（累计值判据）
    maxIdenticalRepeat: 1, // 同一 payload 连续重发的最大次数
  };
  let lastTextLen = 0;
  let lastPayloadJson = "";
  let repeat = 1;
  return {
    stats,
    feed(data: { delta?: unknown; text?: unknown; replace?: unknown }) {
      const hasDelta = typeof data.delta === "string" && data.delta.length > 0;
      const hasText = typeof data.text === "string" && data.text.length > 0;
      if (hasDelta && hasText) stats.both++;
      else if (hasDelta) stats.deltaOnly++;
      else if (hasText) stats.textOnly++;
      if (data.replace === true) stats.replaceTrue++;
      if (hasText) {
        const len = (data.text as string).length;
        if (len < lastTextLen) stats.textIsCumulative = false; // 段边界会重置——观察时对照 tool 事件看
        lastTextLen = len;
      }
      const json = JSON.stringify(data);
      repeat = json === lastPayloadJson ? repeat + 1 : 1;
      lastPayloadJson = json;
      if (repeat > stats.maxIdenticalRepeat) stats.maxIdenticalRepeat = repeat;
    },
  };
}

function describeEnvelope(evt: RawEvent): string {
  const p = (evt.payload ?? {}) as Record<string, unknown>;
  if (evt.event === "agent") {
    const data = (p.data ?? {}) as Record<string, unknown>;
    if (p.stream === "assistant") {
      const d = typeof data.delta === "string" ? data.delta.length : "∅";
      const x = typeof data.text === "string" ? data.text.length : "∅";
      return `agent/assistant deltaLen=${d} textLen=${x} replace=${data.replace === true}`;
    }
    if (p.stream === "item") return `agent/item kind=${data.kind} phase=${data.phase} name=${data.name ?? ""}`;
    return `agent/${p.stream}`;
  }
  if (evt.event === "chat") return `chat state=${p.state} sessionKey=${p.sessionKey}`;
  if (evt.event.startsWith("question")) return `${evt.event} ${JSON.stringify(evt.payload)?.slice(0, 400)}`;
  return `${evt.event} ${JSON.stringify(evt.payload)?.slice(0, 200)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const seenEnvelopes = new Map<string, number>();
  const shapes = makeShapeStats();
  const captured: RawEvent[] = [];

  const onEvent = (evt: RawEvent) => {
    seenEnvelopes.set(evt.event, (seenEnvelopes.get(evt.event) ?? 0) + 1);
    captured.push(evt);
    const p = (evt.payload ?? {}) as Record<string, unknown>;
    if (evt.event === "agent" && p.stream === "assistant") {
      shapes.feed((p.data ?? {}) as Record<string, unknown>);
    }
    if (mode === "--watch" || mode === "--exercise" || mode === "--question-roundtrip") {
      console.log(`${t()} ${describeEnvelope(evt)}`);
    }
  };

  const probe = await connectProbe(onEvent);
  console.log(`connected. handshake scopes = ${JSON.stringify(probe.scopes)}`);

  const printSummary = () => {
    console.log("\n── 汇总 ──");
    console.log(`事件信封名直方图: ${JSON.stringify(Object.fromEntries(seenEnvelopes))}`);
    const s = shapes.stats;
    console.log(
      `assistant 形态: both=${s.both} deltaOnly=${s.deltaOnly} textOnly=${s.textOnly} replace=${s.replaceTrue} ` +
        `text累计单调=${s.textIsCumulative} 同payload最大连发=${s.maxIdenticalRepeat}`,
    );
    if (s.deltaOnly > 0) {
      console.log("⚠ 存在 delta-only 事件——relay 的 agentSnapshotSeen 忽略保护是主防线，确认这些是否为快照后的重述");
    }
  };

  try {
    if (mode === "--status") {
      const search = args[1];
      const result = await probe.request<{ sessions: { key: string; status?: string }[] }>("sessions.list", {
        ...(search ? { search } : {}),
        limit: 20,
      });
      console.log(`sessions.list${search ? `(search=${JSON.stringify(search)})` : ""} → ${result.sessions.length} 行`);
      for (const row of result.sessions) {
        console.log(`  key=${row.key}  status=${row.status}`);
      }
      if (search) {
        const exact = result.sessions.some((r) => r.key === search);
        const suffix = result.sessions.some((r) => r.key.endsWith(`:${search}`));
        console.log(`判据: 全 key 搜索命中=${result.sessions.length > 0} 精确匹配=${exact} 后缀匹配=${suffix}`);
      }
      return;
    }

    if (mode === "--questions") {
      const result = await probe.request<unknown>("question.list", {});
      console.log(`question.list（现有 scope，验证 admin 短路放行）→ ${JSON.stringify(result)?.slice(0, 800)}`);
      return;
    }

    if (mode === "--watch") {
      const key = args[1];
      if (!key) throw new Error("--watch 需要 sessionKey");
      const forSec = Number(args[args.indexOf("--for") + 1]) || 120;
      console.log(`watching all raw events for ${forSec}s（自行在别处触发该会话的活动）...`);
      await new Promise((r) => setTimeout(r, forSec * 1000));
      return;
    }

    if (mode === "--question-roundtrip") {
      // 不依赖 agent 配合就能看到真实 question.* 信封的唯一办法（代价：这几
      // 秒内其他 operator 客户端会看到一张探针问题卡片，随即被取消）。
      console.log("question.request 造探针问题...");
      const created = await probe.request<Record<string, unknown>>("question.request", {
        questions: [
          {
            questionId: "probe_ok",
            header: "探针",
            question: "线上探针问题，会立即自动取消，请忽略",
            options: [{ label: "忽略" }],
          },
        ],
      });
      console.log(`question.request 返回: ${JSON.stringify(created)?.slice(0, 600)}`);
      const id = (created.id ?? (created.question as Record<string, unknown> | undefined)?.id) as string | undefined;
      await new Promise((r) => setTimeout(r, 2000)); // 等广播到达
      if (id) {
        console.log(`question.resolve cancel ${id} ...`);
        await probe.request("question.resolve", { id, cancel: true });
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.log("⚠ 返回里没找到 id，需要人工去 question.list 清理探针问题");
      }
      const requested = captured.find((e) => e.event.startsWith("question") && JSON.stringify(e.payload).includes("probe_ok"));
      const resolved = captured.find((e) => e.event.includes("resolved"));
      console.log("\n判据:");
      console.log(`  question.requested 信封实收=${!!requested} 事件名=${requested?.event}`);
      console.log(`  payload 平铺带 id/questions=${!!(requested && (requested.payload as Record<string, unknown>)?.id)}`);
      console.log(`  question.resolved 信封实收=${!!resolved} payload=${JSON.stringify(resolved?.payload)}`);
      console.log(`  resolved 带 sessionKey=${!!(resolved && (resolved.payload as Record<string, unknown>)?.sessionKey)}（我们假设：不带）`);
      const leftover = await probe.request<unknown>("question.list", {});
      console.log(`  清理复查 question.list=${JSON.stringify(leftover)?.slice(0, 300)}`);
      return;
    }

    if (mode === "--exercise") {
      // 真实 run：让 agent 跑一条 45s 命令，制造"工具调用静默期"，同时轮询
      // sessions.list 验证 status 稳定 running（坑① 判定的地基）。
      const userId = crypto.randomUUID();
      const rawKey = `clickin:chat:${userId}:${crypto.randomUUID()}`;
      console.log(`probe session (raw): ${rawKey}`);
      const message =
        args[1] ?? "请调用 exec 工具执行命令 `sleep 45; echo PROBE_DONE`，等它完成后把输出原样告诉我，不要做任何别的事。";
      const started = await probe.request<{ runId: string; sessionKey: string }>("agent", {
        sessionKey: rawKey,
        message,
        idempotencyKey: crypto.randomUUID(),
      });
      console.log(`canonical echo: ${started.sessionKey}  (raw≠canonical: ${started.sessionKey !== rawKey})`);

      const statusLog: string[] = [];
      const poller = setInterval(async () => {
        try {
          const r = await probe.request<{ sessions: { key: string; status?: string }[] }>("sessions.list", {
            search: rawKey,
            limit: 5,
          });
          const row = r.sessions.find((x) => x.key === started.sessionKey || x.key.endsWith(`:${rawKey}`));
          statusLog.push(`${t()} status=${row?.status ?? "(row missing)"} rows=${r.sessions.length}`);
          console.log(statusLog[statusLog.length - 1]);
        } catch (err) {
          statusLog.push(`${t()} status-poll error: ${err instanceof Error ? err.message : err}`);
        }
      }, 4_000);

      // 等到 final（chat state=final 且非 yielded）或 240s 封顶
      await new Promise<void>((resolve) => {
        const cap = setTimeout(resolve, 240_000);
        const check = setInterval(() => {
          const done = captured.some((e) => {
            if (e.event !== "chat") return false;
            const p = e.payload as Record<string, unknown>;
            return p.state === "final" && p.yielded !== true;
          });
          if (done) {
            clearTimeout(cap);
            clearInterval(check);
            // 给尾部事件一点时间
            setTimeout(resolve, 3000);
          }
        }, 1000);
      });
      clearInterval(poller);

      console.log("\nstatus 轮询记录:");
      for (const line of statusLog) console.log(`  ${line}`);
      const rawKeyEventCount = captured.filter((e) => {
        const p = e.payload as Record<string, unknown>;
        return p?.sessionKey === rawKey;
      }).length;
      const canonicalEventCount = captured.filter((e) => {
        const p = e.payload as Record<string, unknown>;
        return p?.sessionKey === started.sessionKey;
      }).length;
      console.log(`\n判据: raw key 频道事件=${rawKeyEventCount}（假设 0）canonical 频道事件=${canonicalEventCount}`);

      console.log("清理: sessions.delete ...");
      await probe.request("sessions.delete", { key: started.sessionKey }).catch(async () => {
        await probe.request("sessions.delete", { key: rawKey });
      });
      return;
    }

    console.error("用法见文件头注释：--status | --questions | --watch <key> | --question-roundtrip | --exercise");
    process.exitCode = 1;
  } finally {
    printSummary();
    probe.stop();
    // GatewayClient 的 WS 有存活定时器，显式退出
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
