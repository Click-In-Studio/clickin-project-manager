import { describe, it, expect } from "vitest";
import { buildMcpServer, startMcpServer } from "../lib/mcp/server";

// Smoke tests for the MCP server skeleton.
// No HTTP server or DB needed — tests inspect the McpServer instance directly.

type RegisteredTool = { annotations?: { readOnlyHint?: boolean } };
type ToolRegistry = Record<string, RegisteredTool>;

describe("MCP server skeleton", () => {
  it("registers exactly five tools", async () => {
    const server = buildMcpServer();
    const registry = server["_registeredTools"] as ToolRegistry;
    const names = Object.keys(registry).sort();
    expect(names).toEqual(["approvals.list", "docs.propose", "docs.read", "users.query", "users.query_sensitive"]);
    await server.close();
  });

  it("read-only tools have readOnlyHint: true; gated tools do not", async () => {
    const server = buildMcpServer();
    const registry = server["_registeredTools"] as ToolRegistry;
    expect(registry["docs.read"]?.annotations?.readOnlyHint).toBe(true);
    expect(registry["approvals.list"]?.annotations?.readOnlyHint).toBe(true);
    expect(registry["users.query"]?.annotations?.readOnlyHint).toBe(true);
    expect(registry["docs.propose"]?.annotations?.readOnlyHint).toBe(false);
    // 敏感读取刻意不标 readOnly——插件 fail-closed 门控据此自动挂确认门
    expect(registry["users.query_sensitive"]?.annotations?.readOnlyHint).toBeUndefined();
    await server.close();
  });

  it("startMcpServer is idempotent — second call is a no-op", () => {
    const g = global as typeof globalThis & { __mcpHttpServer?: unknown };
    const saved = g.__mcpHttpServer;
    delete g.__mcpHttpServer;

    startMcpServer();
    const first = g.__mcpHttpServer;
    startMcpServer();
    const second = g.__mcpHttpServer;

    expect(first).toBe(second);

    // Clean up
    if (first && typeof (first as { close?: (cb: () => void) => void }).close === "function") {
      (first as { close: (cb: () => void) => void }).close(() => {});
    }
    g.__mcpHttpServer = saved;
  });
});
