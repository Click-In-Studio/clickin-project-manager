import path from "node:path";

/**
 * Nothing here runs at import time — the agent gateway integration is
 * optional, so an instance with no OPENCLAW_GATEWAY_TOKEN configured must
 * still boot and serve the rest of the app normally. "Not configured" is a
 * status the gateway client reports, not a startup failure.
 */

// Team OpenClaw isolated instance (--profile team) listens on 18790.
export const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18790";

// Device identity + paired tokens live here — bearer credentials granting
// operator access to the gateway. Must never be committed or synced.
// Statically scoped join (not resolve of a bare env value) so Turbopack's
// file tracing doesn't fall back to tracing the whole project.
export const GATEWAY_DATA_ROOT = process.env.AGENT_GATEWAY_DATA_PATH
  ? path.resolve(process.env.AGENT_GATEWAY_DATA_PATH)
  : path.join(process.cwd(), "data", "agent-gateway");

export function getGatewayToken(): string | undefined {
  return process.env.OPENCLAW_GATEWAY_TOKEN || undefined;
}

export function isGatewayConfigured(): boolean {
  return Boolean(getGatewayToken());
}
