import { describe, it, expect } from "vitest";
import { parseLine, parseToDoc, serializeAtMention, parseAtMentionToken } from "@/lib/mention-format";

describe("serializeAtMention", () => {
  it("formats with id as new format", () => {
    expect(serializeAtMention("uuid-123", "王恺镔")).toBe("@[王恺镔](uid:uuid-123)");
  });
  it("formats without id as legacy format", () => {
    expect(serializeAtMention(null, "王恺镔")).toBe("@王恺镔");
  });
});

describe("parseAtMentionToken", () => {
  it("parses new format with id", () => {
    expect(parseAtMentionToken("@[王恺镔](uid:uuid-123)")).toEqual({ id: "uuid-123", label: "王恺镔" });
  });
  it("parses legacy format with id=null", () => {
    expect(parseAtMentionToken("@王恺镔")).toEqual({ id: null, label: "王恺镔" });
  });
  it("returns null for non-mention tokens", () => {
    expect(parseAtMentionToken("hello")).toBeNull();
    expect(parseAtMentionToken("@")).toBeNull();
  });
});

describe("parseLine — atMention round-trip", () => {
  it("new-format mention preserves id through parseLine", () => {
    const nodes = parseLine("@[王恺镔](uid:uuid-123)");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "atMention", attrs: { id: "uuid-123", label: "王恺镔" } });
  });

  it("legacy @name mention parses with id=null", () => {
    const nodes = parseLine("@王恺镔");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "atMention", attrs: { id: null, label: "王恺镔" } });
  });

  it("two adjacent new-format mentions split correctly", () => {
    const nodes = parseLine("@[Alice](uid:a1)@[Bob](uid:b2)");
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ type: "atMention", attrs: { id: "a1", label: "Alice" } });
    expect(nodes[1]).toMatchObject({ type: "atMention", attrs: { id: "b2", label: "Bob" } });
  });

  it("@name followed by punctuation does not include punctuation in label", () => {
    const nodes = parseLine("@王恺镔，请注意");
    expect(nodes[0]).toMatchObject({ type: "atMention", attrs: { id: null, label: "王恺镔" } });
    expect(nodes[1]).toMatchObject({ type: "text", text: "，请注意" });
  });

  it("mixed text and mentions", () => {
    const nodes = parseLine("hi @[Alice](uid:a1) and @Bob done");
    expect(nodes).toHaveLength(5);
    expect(nodes[0]).toMatchObject({ type: "text", text: "hi " });
    expect(nodes[1]).toMatchObject({ type: "atMention", attrs: { id: "a1", label: "Alice" } });
    expect(nodes[2]).toMatchObject({ type: "text", text: " and " });
    expect(nodes[3]).toMatchObject({ type: "atMention", attrs: { id: null, label: "Bob" } });
    expect(nodes[4]).toMatchObject({ type: "text", text: " done" });
  });
});

describe("parseToDoc", () => {
  it("splits multi-line text into paragraphs", () => {
    const doc = parseToDoc("line one\nline two");
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(2);
    expect(doc.content![0]).toMatchObject({ type: "paragraph" });
    expect(doc.content![1]).toMatchObject({ type: "paragraph" });
  });

  it("preserves mention id across lines", () => {
    const doc = parseToDoc("@[Alice](uid:a1)\n@Bob");
    const p0 = doc.content![0].content!;
    const p1 = doc.content![1].content!;
    expect(p0[0]).toMatchObject({ type: "atMention", attrs: { id: "a1", label: "Alice" } });
    expect(p1[0]).toMatchObject({ type: "atMention", attrs: { id: null, label: "Bob" } });
  });

  it("empty line produces paragraph with no content", () => {
    const doc = parseToDoc("hello\n\nworld");
    expect(doc.content).toHaveLength(3);
    expect(doc.content![1].content).toBeUndefined();
  });
});

describe("parseLine — new-format round-trip via serializeAtMention", () => {
  it("serialize then parse preserves id", () => {
    const serialized = serializeAtMention("uuid-xyz", "张三");
    const nodes = parseLine(serialized);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "atMention", attrs: { id: "uuid-xyz", label: "张三" } });
  });
});
