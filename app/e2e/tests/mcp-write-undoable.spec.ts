/**
 * C1a — MCP/AI cell writes are UNDOABLE + emit grid:refresh, end-to-end through
 * the REAL bearer-token Streamable-HTTP server.
 *
 * set_cell_value funnels through execute_script, which now routes its writes
 * through apply_script_modified_grids — the SAME undoable edit pipeline the
 * in-app run_script uses (already proven by undoable-macros.spec.ts). This test
 * adds the MCP-specific deltas that nothing else covers:
 *   - the HTTP / JSON-RPC bearer transport actually reaching that path, and
 *   - the grid:refresh Tauri event (bridged to a window event in bootstrap.ts)
 *     firing so an OUT-OF-BAND AI write refreshes the open grid.
 *
 * The MCP HTTP handshake runs from the Node test process (NOT page.evaluate):
 * a cross-origin browser fetch from the WebView to the server's port would hit
 * CORS preflight, while Node has no CORS. The session token + port come from
 * mcp_status via page.evaluate; the cell/undo/grid:refresh checks run back in
 * the WebView (where the bridge lives).
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

test.describe("MCP/AI writes are undoable + emit grid:refresh (C1a)", () => {
  test("an MCP set_cell_value write goes through the undoable edit pipeline and refreshes the grid", async ({
    appPage: page,
  }) => {
    // 1. In the WebView: allow scripts, clear the target cell, arm a grid:refresh
    //    listener (persists on window across evaluates), start the server, read
    //    the session token + port.
    const setup = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_script_security_level", { level: "enabled" });
      await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" });

      (window as any).__E2E_GRID_REFRESH__ = false;
      if (!(window as any).__E2E_REFRESH_BOUND__) {
        (window as any).__E2E_REFRESH_BOUND__ = true;
        window.addEventListener("grid:refresh", () => {
          (window as any).__E2E_GRID_REFRESH__ = true;
        });
      }

      await tauri.core.invoke("mcp_start", {});
      const status: any = await tauri.core.invoke("mcp_status", {});
      return { port: status.port as number, token: status.token as string | null };
    });

    expect(setup.token, "mcp_status must return a session bearer token").toBeTruthy();

    const url = `http://127.0.0.1:${setup.port}/mcp`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${setup.token}`,
    };

    try {
      // 2a. initialize -> capture the Mcp-Session-Id for subsequent requests.
      const initRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "calcula-e2e", version: "1.0" },
          },
        }),
      });
      const initText = await initRes.text();
      const initJson = parseMcp(initRes.headers.get("content-type") ?? "", initText);
      const sessionId = initRes.headers.get("mcp-session-id");
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;

      expect(initRes.ok, `initialize failed (${initRes.status}): ${initText.slice(0, 300)}`).toBe(true);
      expect(initJson?.result?.protocolVersion, "initialize must return a protocolVersion").toBeTruthy();

      // 2b. notifications/initialized — completes the handshake.
      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });

      // 2c. tools/call set_cell_value A1 = 42 (the AI write).
      const callRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "set_cell_value", arguments: { row: 0, col: 0, value: "42" } },
        }),
      });
      const callText = await callRes.text();
      const callJson = parseMcp(callRes.headers.get("content-type") ?? "", callText);

      expect(callRes.ok, `tools/call failed (${callRes.status}): ${callText.slice(0, 300)}`).toBe(true);
      expect(callJson?.error ?? null, "tools/call returned a JSON-RPC error").toBeNull();
      // The tool itself must not report an error result.
      expect(callJson?.result?.isError ?? false).toBe(false);

      // 3. Back in the WebView: the write applied, grid:refresh fired, and a
      //    single undo reverts it (proving the write went through the undo stack).
      const after = await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        // Let the backend grid:refresh emit -> bootstrap bridge -> window event propagate.
        await new Promise((r) => setTimeout(r, 300));
        const cell: any = await tauri.core.invoke("get_cell", { row: 0, col: 0 });
        const refreshFired = (window as any).__E2E_GRID_REFRESH__ === true;
        await tauri.core.invoke("undo");
        const undone: any = await tauri.core.invoke("get_cell", { row: 0, col: 0 });
        return {
          writeDisplay: String(cell?.display ?? cell?.value ?? ""),
          undoDisplay: String(undone?.display ?? undone?.value ?? ""),
          refreshFired,
        };
      });

      // The AI write applied...
      expect(after.writeDisplay).toContain("42");
      // ...went through the undo stack (one undo reverts it)...
      expect(after.undoDisplay).toBe("");
      // ...and emitted grid:refresh, bridged to the window event.
      expect(after.refreshFired).toBe(true);

      // Newline robustness (serde_json JS-literal escaping): a value with a
      // literal newline must not produce an unterminated JS string / failed write.
      const mlRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "set_cell_value", arguments: { row: 2, col: 0, value: "line1\nline2" } },
        }),
      });
      const mlJson = parseMcp(mlRes.headers.get("content-type") ?? "", await mlRes.text());
      expect(mlRes.ok).toBe(true);
      expect(mlJson?.result?.isError ?? false, "a newline value must not fail the write").toBe(false);
      const mlCell = await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        const c: any = await tauri.core.invoke("get_cell", { row: 2, col: 0 });
        return String(c?.display ?? c?.value ?? "");
      });
      expect(mlCell).toContain("line1");
    } finally {
      await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        try {
          await tauri.core.invoke("mcp_stop", {});
        } catch {
          /* already stopped */
        }
        await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" });
        await tauri.core.invoke("update_cell", { row: 2, col: 0, value: "" });
      });
    }
  });
});
