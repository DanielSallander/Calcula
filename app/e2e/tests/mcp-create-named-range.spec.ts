/**
 * C1 — MCP create_named_range write tool, end-to-end through the live
 * bearer-token MCP server.
 *
 * Lets an AI CREATE workbook structure (a named range), not just read it. The
 * tool routes through the same undoable create_named_range command the UI uses
 * and then emits "named-ranges:refresh" (the DefinedNames extension bridges that
 * Tauri event to NAMED_RANGES_CHANGED, so an out-of-band create appears live).
 *
 * Asserts: (1) the create succeeds, (2) list_named_ranges shows the new name,
 * (3) the named-ranges:refresh event fired (the live-refresh path), and (4) a
 * single undo removes it (it went through the undo stack). The handshake runs
 * from Node (no CORS); the Tauri-event listener + read-back/undo run in the
 * WebView.
 */
import { test, expect } from "../fixtures";

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

test.describe("MCP create_named_range write tool (C1)", () => {
  test("an AI-created named range persists, lists, fires a refresh, and is undoable", async ({
    appPage: page,
  }) => {
    const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const nrName = `E2eName${uniq}`;

    const setup = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_script_security_level", { level: "enabled" });
      // Arm a listener for the backend "named-ranges:refresh" Tauri event (the
      // live-refresh signal the DefinedNames bridge consumes).
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      (window as any).__NR_REFRESH__ = false;
      await api.listenTauriEvent("named-ranges:refresh", () => {
        (window as any).__NR_REFRESH__ = true;
      });
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

      // 1. create_named_range (snake_case args — MCP param convention).
      const create = await rpc(2, "tools/call", {
        name: "create_named_range",
        arguments: { name: nrName, refers_to: "=0.25" },
      });
      expect(create.ok, `create failed: ${create.text.slice(0, 300)}`).toBe(true);
      expect(create.json?.error ?? null).toBeNull();
      expect(create.json?.result?.isError ?? false, "create_named_range reported a tool error").toBe(false);

      // 2. list_named_ranges shows the new name.
      const list = await rpc(3, "tools/call", { name: "list_named_ranges", arguments: {} });
      const listText: string = list.json?.result?.content?.[0]?.text ?? "";
      expect(listText).toContain(nrName);

      // 3. The backend emitted named-ranges:refresh (the live-refresh path).
      const refreshFired = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 300));
        return (window as any).__NR_REFRESH__ === true;
      });
      expect(refreshFired, "create_named_range must emit named-ranges:refresh").toBe(true);

      // 4. Undoable: a single undo removes the AI-created name.
      const namesAfterUndo = await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("undo");
        const ranges: any[] = await tauri.core.invoke("get_all_named_ranges");
        return ranges.map((r) => r.name);
      });
      expect(namesAfterUndo).not.toContain(nrName);
    } finally {
      await page.evaluate(async (name) => {
        const tauri = (window as any).__TAURI__;
        try {
          await tauri.core.invoke("mcp_stop", {});
        } catch {
          /* already stopped */
        }
        // Undo already removed it; delete is a best-effort backstop.
        try {
          await tauri.core.invoke("delete_named_range", { name });
        } catch {
          /* gone */
        }
      }, nrName);
    }
  });
});
