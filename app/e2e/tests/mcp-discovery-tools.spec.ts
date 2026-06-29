/**
 * C1 — the typed MCP discovery tool tier over real subsystems.
 *
 * list_pivots + list_tables (new) join list_charts + list_named_ranges so an AI
 * client can discover every first-class object via tools/list. get_sheet_summary
 * now also folds "## Tables" and "## Pivots" sections into the workbook summary.
 *
 * This drives the live bearer-token MCP server (handshake from Node, no CORS) to
 * assert: (1) the new tools appear in tools/list, (2) they are callable without
 * error, and (3) get_sheet_summary runs end-to-end — exercising the new
 * tables-then-pivots locking path in the enrichment (which the pure-formatter
 * unit tests do NOT cover), so a lock-ordering deadlock/panic there would fail
 * here.
 */
import { test, expect } from "../fixtures";

/** Parse an MCP Streamable-HTTP response body (SSE or JSON) into its JSON-RPC payload. */
function parseMcp(contentType: string, body: string): any {
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

test.describe("MCP discovery tool tier (C1)", () => {
  test("list_pivots + list_tables are registered, callable, and get_sheet_summary folds them in", async ({
    appPage: page,
  }) => {
    const setup = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("mcp_start", {});
      const status: any = await tauri.core.invoke("mcp_status", {});
      return { port: status.port as number, token: status.token as string | null };
    });
    expect(setup.token).toBeTruthy();

    const url = `http://127.0.0.1:${setup.port}/mcp`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${setup.token}`,
    };

    /** POST a JSON-RPC message and return the parsed payload. */
    const rpc = async (id: number | null, method: string, params?: unknown) => {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
      });
      const text = await res.text();
      return { ok: res.ok, json: parseMcp(res.headers.get("content-type") ?? "", text), text };
    };

    try {
      // Handshake.
      const init = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "calcula-e2e", version: "1.0" } },
        }),
      });
      const sessionId = init.headers.get("mcp-session-id");
      await init.text();
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      expect(init.ok).toBe(true);
      await rpc(null, "notifications/initialized");

      // 1. tools/list includes the new discovery tools.
      const list = await rpc(2, "tools/list");
      expect(list.ok, `tools/list failed: ${list.text.slice(0, 300)}`).toBe(true);
      const names: string[] = (list.json?.result?.tools ?? []).map((t: any) => t.name);
      for (const expected of ["list_tables", "list_pivots", "list_named_ranges", "list_charts"]) {
        expect(names, `tools/list should expose ${expected}`).toContain(expected);
      }

      // 2. The new tools are callable without error (empty workbook -> the
      //    "(no ...)" messages, but no JSON-RPC error / tool error).
      for (const tool of ["list_tables", "list_pivots"]) {
        const call = await rpc(3, "tools/call", { name: tool, arguments: {} });
        expect(call.ok, `${tool} call failed: ${call.text.slice(0, 300)}`).toBe(true);
        expect(call.json?.error ?? null, `${tool} returned a JSON-RPC error`).toBeNull();
        expect(call.json?.result?.isError ?? false, `${tool} reported a tool error`).toBe(false);
      }

      // 3. get_sheet_summary runs end-to-end (exercises the new tables+pivots
      //    enrichment locking path) and returns text.
      // max_chars has a serde default, so omit it (avoids any arg-name coupling).
      const summary = await rpc(4, "tools/call", { name: "get_sheet_summary", arguments: {} });
      expect(summary.ok, `get_sheet_summary failed: ${summary.text.slice(0, 300)}`).toBe(true);
      expect(summary.json?.error ?? null).toBeNull();
      expect(summary.json?.result?.isError ?? false).toBe(false);
      const summaryText: string = summary.json?.result?.content?.[0]?.text ?? "";
      expect(summaryText.length).toBeGreaterThan(0);
    } finally {
      await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        try {
          await tauri.core.invoke("mcp_stop", {});
        } catch {
          /* already stopped */
        }
      });
    }
  });
});
