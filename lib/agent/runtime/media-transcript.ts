import type { SessionTreeEntry } from "../../../vendor/openclaw/packages/agent-core/src/harness/types";

/** 附件原件留在对象存储，新轨迹行只存版本身份和测量信息。 */
export function durableMediaEntry(entry: SessionTreeEntry): SessionTreeEntry {
  return JSON.parse(
    JSON.stringify(entry, (_key, value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "attachmentId" in value &&
        "source" in value &&
        value.source &&
        typeof value.source === "object" &&
        "kind" in value.source &&
        value.source.kind === "attachment"
      ) {
        const reference = { ...(value as Record<string, unknown>) };
        delete reference.data;
        return reference;
      }
      return value;
    }),
  ) as SessionTreeEntry;
}
