/**
 * C1 — MCP create_table write tool, end-to-end through the live bearer-token
 * MCP server.
 *
 * Lets an AI create a structured table. The tool routes through the SAME
 * undoable create_table command the UI uses (table + autofilter in one undo
 * transaction) and announces the mutation so an out-of-band create appears live.
 *
 * Asserts: (1) the create succeeds, (2) list_tables shows the new table, (3) the
 * announcement reached the UI, and (4) a single undo removes it. Handshake from
 * Node (no CORS); seeding + listener + read-back/undo in the WebView.
 *
 * ============================================================================
 * WHAT (3) ASSERTS NOW, AND WHY IT CHANGED (2026-08-12, live functional run)
 * ============================================================================
 * This test used to listen for the Tauri event `"tables:refresh"` BY NAME. §3cd
 * (BUG-0026) deleted that event, along with `charts:refresh`, `pivots:refresh`,
 * `named-ranges:refresh` and `sheets:refresh` — five bespoke per-kind
 * announcements, one of which nothing had ever listened to — and replaced all
 * five with ONE `mutation:refresh` carrying `{ domains, source }`, which the
 * Shell fans out through `MUTATION_DOMAIN_EVENTS` into the very same feature
 * events the extensions already consume. That is a better contract and the
 * product is fine; the TEST was left naming a transport that no longer exists,
 * and this run is the first time anything said so.
 *
 * So the assertion is now made at BOTH levels, deliberately:
 *
 *   - the BACKEND ANNOUNCED: a `mutation:refresh` arrived, and it named the
 *     `objects` domain — the domain `ObjectKind::Table` maps to in
 *     `object_deps::ui_domain`;
 *   - the UI HEARD IT: the Shell's fan-out dispatched
 *     TABLE_DEFINITIONS_UPDATED, which is what the Table extension's
 *     `refreshCache` actually listens to, and therefore the thing that decides
 *     whether the user sees the table.
 *
 * Two levels because they fail for opposite reasons and cost a run each to tell
 * apart otherwise: only the first firing means the Shell bridge broke; only the
 * second means something else dispatched it and the backend said nothing.
 * Naming the transport alone could never have distinguished either.
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
      // Arm BOTH halves of the announcement (see the header).
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      (window as any).__TBL_ANNOUNCED_DOMAINS__ = null;
      (window as any).__TBL_UI_HEARD__ = false;
      await api.listenTauriEvent("mutation:refresh", (payload: any) => {
        const domains: string[] = payload?.domains ?? [];
        const seen: string[] = (window as any).__TBL_ANNOUNCED_DOMAINS__ ?? [];
        (window as any).__TBL_ANNOUNCED_DOMAINS__ = [...seen, ...domains];
      });
      window.addEventListener("app:table-definitions-updated", () => {
        (window as any).__TBL_UI_HEARD__ = true;
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

      // 3. The mutation was announced, and the announcement reached the UI.
      const announced = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 300));
        return {
          domains: (window as any).__TBL_ANNOUNCED_DOMAINS__ as string[] | null,
          uiHeard: (window as any).__TBL_UI_HEARD__ === true,
        };
      });
      expect(
        announced.domains,
        "create_table must announce the mutation (object_deps::announce_cascade " +
          "-> the mutation:refresh Tauri event). Nothing arrived at all.",
      ).not.toBeNull();
      expect(
        announced.domains,
        "the announcement must name the `objects` domain — that is what " +
          "ObjectKind::Table maps to in object_deps::ui_domain",
      ).toContain("objects");
      expect(
        announced.uiHeard,
        "the Shell must fan `objects` out to TABLE_DEFINITIONS_UPDATED — that " +
          "is the event the Table extension refreshes its overlay cache on, so " +
          "without it an AI-created table is invisible until something else " +
          "redraws",
      ).toBe(true);

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
      // THE TABLE IS REMOVED HERE, NOT ONLY BY STEP 4'S UNDO.
      //
      // MEASURED 2026-08-12: when step 3 failed, this `finally` cleared the
      // seeded CELLS and left the TABLE — because the only thing that removed
      // it was the `undo` in step 4, inside the `try`, after the assertion that
      // threw. The AI-created table then sat at A1:B3 for the rest of the
      // ordered run with its header fill, its banded rows and its "Table
      // Design" CONTEXTUAL RIBBON TAB, and took six later specs down with it:
      // paste-special x2 and scrolling photographed the blue table where their
      // goldens have white, and two ribbon-tabs goldens differed by exactly the
      // 68x12 px of the extra tab's label. Three root failures presented as
      // nine.
      //
      // A cleanup that runs only when the assertions passed is not a cleanup.
      // Deleting by NAME (not "the first table") so this cannot remove a table
      // some other spec owns.
      await page.evaluate(async (name: string) => {
        const tauri = (window as any).__TAURI__;
        try {
          await tauri.core.invoke("mcp_stop", {});
        } catch {
          /* already stopped */
        }
        try {
          const tables: any[] = await tauri.core.invoke("get_all_tables", {});
          for (const t of tables ?? []) {
            if (t?.name === name) {
              await tauri.core.invoke("delete_table", { tableId: t.id });
            }
          }
        } catch {
          /* nothing to remove */
        }
        // Clear the seeded cells.
        for (let row = 0; row <= 2; row++) {
          for (let col = 0; col <= 1; col++) {
            await tauri.core.invoke("update_cell", { row, col, value: "" });
          }
        }
      }, tableName);
    }
  });
});
