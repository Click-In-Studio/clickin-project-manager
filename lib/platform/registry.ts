import type { PersonalChannel, OrgChannel, InboundGateway, PlatformId } from "./types";
import { feishuPlatform } from "./feishu";

const personalChannels = new Map<PlatformId, PersonalChannel>([["feishu", feishuPlatform]]);
const orgChannels      = new Map<PlatformId, OrgChannel>([["feishu", feishuPlatform]]);
const gateways         = new Map<PlatformId, InboundGateway>([["feishu", feishuPlatform]]);

export function getPersonalChannel(platformId: string): PersonalChannel {
  const ch = personalChannels.get(platformId as PlatformId);
  if (!ch) throw new Error(`No PersonalChannel registered for platform: ${platformId}`);
  return ch;
}

export function getOrgChannel(platformId: string): OrgChannel {
  const ch = orgChannels.get(platformId as PlatformId);
  if (!ch) throw new Error(`No OrgChannel registered for platform: ${platformId}`);
  return ch;
}

export function getGateway(platformId: string): InboundGateway {
  const gw = gateways.get(platformId as PlatformId);
  if (!gw) throw new Error(`No InboundGateway registered for platform: ${platformId}`);
  return gw;
}

export function registerPersonalChannel(ch: PersonalChannel): void {
  personalChannels.set(ch.platformId, ch);
}

export function registerOrgChannel(ch: OrgChannel): void {
  orgChannels.set(ch.platformId, ch);
}

export function registerGateway(gw: InboundGateway): void {
  gateways.set(gw.platformId, gw);
}
