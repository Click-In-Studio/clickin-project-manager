import type { PersonalChannel, OrgChannel, InboundGateway, PlatformId } from "./types";

// Maps are lazily populated on first access to break a circular dependency:
//   feishu/index → lib/db → lib/notify → feishu-bot → registry → feishu/index
// Static imports of feishuPlatform / emailPlatform at module evaluation time
// put both singletons on the TDZ path when Turbopack reorders the chunk graph
// (exposed after @modelcontextprotocol/sdk enlarged the dependency tree).
let _personal: Map<PlatformId, PersonalChannel> | undefined;
let _org: Map<PlatformId, OrgChannel> | undefined;
let _gateways: Map<PlatformId, InboundGateway> | undefined;

function initMaps(): void {
  if (_personal) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { feishuPlatform } = require("./feishu") as typeof import("./feishu");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { emailPlatform } = require("./email") as typeof import("./email");
  _personal  = new Map<PlatformId, PersonalChannel>([["feishu", feishuPlatform], ["email", emailPlatform]]);
  _org       = new Map<PlatformId, OrgChannel>([["feishu", feishuPlatform]]);
  _gateways  = new Map<PlatformId, InboundGateway>([["feishu", feishuPlatform], ["email", emailPlatform]]);
}

export function getPersonalChannel(platformId: string): PersonalChannel {
  initMaps();
  const ch = _personal!.get(platformId as PlatformId);
  if (!ch) throw new Error(`No PersonalChannel registered for platform: ${platformId}`);
  return ch;
}

export function getOrgChannel(platformId: string): OrgChannel {
  initMaps();
  const ch = _org!.get(platformId as PlatformId);
  if (!ch) throw new Error(`No OrgChannel registered for platform: ${platformId}`);
  return ch;
}

export function getGateway(platformId: string): InboundGateway {
  initMaps();
  const gw = _gateways!.get(platformId as PlatformId);
  if (!gw) throw new Error(`No InboundGateway registered for platform: ${platformId}`);
  return gw;
}

export function registerPersonalChannel(ch: PersonalChannel): void {
  initMaps();
  _personal!.set(ch.platformId, ch);
}

export function registerOrgChannel(ch: OrgChannel): void {
  initMaps();
  _org!.set(ch.platformId, ch);
}

export function registerGateway(gw: InboundGateway): void {
  initMaps();
  _gateways!.set(gw.platformId, gw);
}
