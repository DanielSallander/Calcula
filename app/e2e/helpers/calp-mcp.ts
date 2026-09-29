/**
 * The live bearer-token MCP server, for fixall-calp.spec.ts: start it, call a
 * tool from Node (no CORS), stop it. The handshake is the one
 * tests/mcp-create-named-range.spec.ts proved.
 */
import type { Page } from "@playwright/test";
import { invoke } from "./calp-harness";

function parseMcp(contentType: string, body: string): unknown {
  if (contentType.includes("text/event-stream")) {
    const dataLines = body
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = dataLines[dataLines.length - 1];
    return last ? JSON.parse(last) : null;
  }
  return body ? JSON.parse(body) : null;
}

export interface McpSession {
  /** Call a tool; returns its text and whether the tool reported an error. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  stop(): Promise<void>;
}

export async function startMcp(page: Page): Promise<McpSession> {
  const previousLevel = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
  await invoke(page, "set_script_security_level", { level: "enabled" });
  await invoke(page, "mcp_start", {}).catch(() => undefined); // already running is fine
  const status = await invoke<{ port: number; token: string | null }>(page, "mcp_status", {});
  if (!status.token) throw new Error("the MCP server issued no bearer token");
  const url = `http://127.0.0.1:${status.port}/mcp`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${status.token}`,
  };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "calcula-e2e-fixall", version: "1.0" } },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  await init.text();
  if (!init.ok) throw new Error(`MCP initialize failed: ${init.status}`);
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then((r) => r.text());
  let id = 10;
  return {
    async call(name, args) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      });
      const raw = await res.text();
      const json = parseMcp(res.headers.get("content-type") ?? "", raw) as
        | { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } }
        | null;
      if (json?.error) return { text: String(json.error.message ?? "error"), isError: true };
      return { text: json?.result?.content?.[0]?.text ?? raw, isError: json?.result?.isError === true };
    },
    async stop() {
      await invoke(page, "mcp_stop", {}).catch(() => undefined);
      await invoke(page, "set_script_security_level", { level: previousLevel }).catch(() => undefined);
    },
  };
}
