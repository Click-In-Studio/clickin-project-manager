import { describe, it, expect } from "vitest";
import { parseSessionIdentity } from "@/lib/agent-tools/session-identity";

const USER = "0b6ab930-e2aa-4020-8334-d749d7be82a5";
const SESS = "11111111-2222-3333-4444-555555555555";

describe("parseSessionIdentity", () => {
  it("personal session: userId only", () => {
    expect(parseSessionIdentity(`clickin:chat:${USER}:${SESS}`)).toEqual({ userId: USER, productionId: undefined });
  });

  it("production session: userId + productionId (short alnum id)", () => {
    expect(parseSessionIdentity(`clickin:chat:${USER}:t3k9xa1b:${SESS}`)).toEqual({
      userId: USER,
      productionId: "t3k9xa1b",
    });
  });

  it("canonical agent prefix and heartbeat suffix both parse", () => {
    expect(parseSessionIdentity(`agent:team:clickin:chat:${USER}:t3k9xa1b:${SESS}:heartbeat`)).toEqual({
      userId: USER,
      productionId: "t3k9xa1b",
    });
    expect(parseSessionIdentity(`agent:team:clickin:chat:${USER}:${SESS}`)).toEqual({
      userId: USER,
      productionId: undefined,
    });
  });

  it("session uuid is never mistaken for a production id", () => {
    // 只有两段 UUID 时，第二段必须解析为会话 id 而非 production
    const parsed = parseSessionIdentity(`clickin:chat:${USER}:${SESS}`);
    expect(parsed?.productionId).toBeUndefined();
  });

  it("garbage keys parse to null", () => {
    expect(parseSessionIdentity("mindweave:chat:xyz")).toBeNull();
    expect(parseSessionIdentity(undefined)).toBeNull();
    expect(parseSessionIdentity(`clickin:chat:not-a-uuid:${SESS}`)).toBeNull();
  });
});
