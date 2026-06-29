/**
 * C1 — MCP create_table write tool, end-to-end through the live bearer-token
 * MCP server.
 *
 * Lets an AI create a structured table. The tool routes through the SAME
 * undoable create_table command the UI uses (table + autofilter in one undo
 * transaction) and emits "tables:refresh" (the Table extension bridges that
 * Tauri event to a TABLE_DEFINITIONS_UPDATED window event, so an out-of-band
 * create appears live).
 *
 * Asserts: (1) the create succeeds, (2) list_tables shows the new table, (3) the
 * tables:refresh event fired, and (4) a single undo removes it. Handshake from
 * Node (no CORS); seeding + listener + read-back/undo in the WebView.
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

test.describe("MCP create_table write tool (C1)", () => {
  test("an AI-created table persists, lists, fires a refresh, and is undoable", async ({
    appPage: page,
  }) => {
    const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const tableName = `E2eTable${uniq}`;

    const setup = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_script_security_level", { level: "enabled" });
      // Seed a header row + 2 data rows (A1:B3) so has_headers reads column names.
      const seed: Array<[number, number, string]> = [
        [0, 0, "Region"], [0, 1, "Revenue"],
        [1, 0, "North"], [1, 1, "100"],
        [2, 0, "South"], [2, 1, "200"],
      ];
      for (const [row, col, value] of seed) {
        await tauri.core.invoke("update_cell", { row, col, value });
      }
      // Arm a listener for the backend "tables:refresh" Tauri event.
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      (window as any).__TBL_REFRESH__ = false;
      await api.listenTauriEvent("tables:refresh", () => {
        (window as any).__TBL_REFRESH__ = true;
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

      // 1. create_table over A1:B3 with headers (snake_case args).
      const create = await rpc(2, "tools/call", {
        name: "create_table",
        arguments: { start_row: 0, start_col: 0, end_row: 2, end_col: 1, has_headers: true, name: tableName },
      });
      expect(create.ok, `create failed: ${create.text.slice(0, 300)}`).toBe(true);
      expect(create.json?.error ?? null).toBeNull();
      expect(create.json?.result?.isError ?? false, "create_table reported a tool error").toBe(false);

      // 2. list_tables shows the new table.
      const list = await rpc(3, "tools/call", { name: "list_tables", arguments: {} });
      const listText: string = list.json?.result?.content?.[0]?.text ?? "";
      expect(listText).toContain(tableName);

      // 3. The backend emitted tables:refresh (the live-refresh path).
      const refreshFired = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 300));
        return (window as any).__TBL_REFRESH__ === true;
      });
      expect(refreshFired, "create_table must emit tables:refresh").toBe(true);

      // 4. Undoable: a single undo removes the AI-created table (the create is one
      //    transaction on top of the seeded-cell edits).
      const namesAfterUndo = await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("undo");
        const tables: any[] = await tauri.core.invoke("get_all_tables");
        return tables.map((t) => t.name);
      });
      expect(namesAfterUndo).not.toContain(tableName);
    } finally {
      await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        try {
          await tauri.core.invoke("mcp_stop", {});
        } catch {
          /* already stopped */
        }
        // Clear the seeded cells.
        for (let row = 0; row <= 2; row++) {
          for (let col = 0; col <= 1; col++) {
            await tauri.core.invoke("update_cell", { row, col, value: "" });
          }
        }
      });
    }
  });
});
